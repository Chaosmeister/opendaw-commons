// @label Rotor
// @param mix 1 [omit-default-ui]
// @param turn 2 0 5 int [omit-default-ui]
// @view 1 1 5 3
// @window 560 420
// @buffer shapes 1024
// @stream state 9

const EFFECTS = ["Drive", "Crush", "Ring", "Comb", "Filter", "Gate", "Echo", "Space"]
const TURNS = [0.25, 0.5, 1, 2, 4, 8]
const TURN_LABELS = ["¼", "½", "1", "2", "4", "8"]
const icon = path => `<svg viewBox="0 0 9 9" fill="none" stroke="currentColor"><path d="${path}"/></svg>`
const ICONS = {
    smooth: icon("M.5 6C2.5 1 4 1 4.5 4.5S6.5 8 8.5 3"),
    snap: icon("M.5 8.5h2.5v-3h3v-3h2.5"),
    reset: icon("M4.5 .5a4 4 0 1 0 .01 0"),
    random: icon("M1 1.5h1M7 2h1M3.5 4.5h1M1.5 7h1M6.5 7.5h1"),
    window: icon("M3.5 1.5h-2v6h6v-2M5 .5h3.5V4M8.5.5 4 5")
}
const SNAPS = [0, 2, 4, 8, 16]
const RESOLUTION = 128
const TAU = Math.PI * 2
const PPQN_BAR = 3840
const SMOOTHING_SECONDS = 0.004
const GATE_PATTERN = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0]
const COMB_SIZES = [1116, 1188, 1277, 1356]
const ALLPASS_SIZES = [556, 441]
const STEREO_SPREAD = 23

const clampUnit = value => Math.max(0, Math.min(1, value))
const wrapUnit = value => value - Math.floor(value)
const powerOfTwoAbove = value => 1 << Math.ceil(Math.log2(value))

class Processor {
    constructor() {
        this.mix = 1; this.mixTarget = 1
        this.turn = 2
        this.rotation = 0
        this.amounts = new Float32Array(EFFECTS.length)
        this.shapes = new Float32Array(EFFECTS.length * RESOLUTION)
        this.smoothing = 1 - Math.exp(-1 / (SMOOTHING_SECONDS * sampleRate))
        this.crushPhase = 0; this.crushL = 0; this.crushR = 0
        this.ringPhase = 0
        this.combMask = powerOfTwoAbove(sampleRate * 0.05) - 1
        this.combL = new Float32Array(this.combMask + 1); this.combR = new Float32Array(this.combMask + 1)
        this.combDelay = sampleRate / 60
        this.svf = new Float64Array(4)
        this.k = 2; this.a1 = 1; this.a2 = 0; this.a3 = 0
        this.gate = 1
        this.echoMask = powerOfTwoAbove(sampleRate * 3) - 1
        this.echoL = new Float32Array(this.echoMask + 1); this.echoR = new Float32Array(this.echoMask + 1)
        this.echoDamp = new Float64Array(2)
        this.echoTime = sampleRate * 0.375
        this.write = 0
        const scale = sampleRate / 44100
        this.combs = [0, STEREO_SPREAD].map(spread => COMB_SIZES.map(size => ({buffer: new Float32Array(Math.round((size + spread) * scale)), index: 0, filter: 0})))
        this.allpasses = [0, STEREO_SPREAD].map(spread => ALLPASS_SIZES.map(size => ({buffer: new Float32Array(Math.round((size + spread) * scale)), index: 0})))
    }
    paramChanged(name, value) {
        if (name === "mix") this.mixTarget = value
        else if (name === "turn") this.turn = Math.max(0, Math.min(TURNS.length - 1, Math.round(value)))
    }
    dataChanged(name) {
        if (name === "shapes") this.shapes.set(this.data.shapes)
    }
    reset() {
        for (const buffer of [this.combL, this.combR, this.svf, this.echoL, this.echoR, this.echoDamp]) buffer.fill(0)
        for (const side of this.combs) for (const comb of side) {comb.buffer.fill(0); comb.filter = 0}
        for (const side of this.allpasses) for (const allpass of side) allpass.buffer.fill(0)
        this.amounts.fill(0)
    }
    process({src, out}, {s0, s1, p0, p1, bpm, flags}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const tempo = bpm > 0 ? bpm : 120
        const playing = (flags & 4) !== 0
        const turnPpqn = TURNS[this.turn] * PPQN_BAR
        const ppqnPerSample = s1 > s0 ? (p1 - p0) / (s1 - s0) : 0
        for (let i = s0; i < s1; i++) {
            const position = p0 + (i - s0) * ppqnPerSample
            if (playing) this.rotation = wrapUnit(position / turnPpqn)
            this.readShapes()
            this.mix += (this.mixTarget - this.mix) * this.smoothing
            const inL = srcL[i], inR = srcR[i]
            let l = inL, r = inR
            const [drive, crush, ring, comb, filter, gate, echo, space] = this.amounts
            if (drive > 1e-4) {
                const gain = 1 + drive * 24, makeup = Math.pow(gain, -0.6), blend = Math.min(1, drive * 8)
                l += (Math.tanh(l * gain) * makeup - l) * blend
                r += (Math.tanh(r * gain) * makeup - r) * blend
            }
            if (crush > 1e-4) {
                this.crushPhase += 1 / (1 + crush * crush * 40)
                if (this.crushPhase >= 1) {
                    this.crushPhase -= Math.floor(this.crushPhase)
                    const steps = Math.pow(2, 16 - crush * 13)
                    this.crushL = Math.round(l * steps) / steps
                    this.crushR = Math.round(r * steps) / steps
                }
                const blend = Math.min(1, crush * 8)
                l += (this.crushL - l) * blend
                r += (this.crushR - r) * blend
            }
            this.ringPhase = wrapUnit(this.ringPhase + 40 * Math.pow(2, ring * 6) / sampleRate)
            if (ring > 1e-4) {
                const carrier = Math.sin(this.ringPhase * TAU), blend = Math.min(1, ring * 3)
                l += (l * carrier - l) * blend
                r += (r * carrier - r) * blend
            }
            this.combDelay += (sampleRate / (55 * Math.pow(2, comb * 5)) - this.combDelay) * 0.001
            const combedL = this.readLine(this.combL, this.combMask, this.combDelay)
            const combedR = this.readLine(this.combR, this.combMask, this.combDelay * 1.01)
            this.combL[this.write & this.combMask] = Math.tanh(l + combedL * 0.92)
            this.combR[this.write & this.combMask] = Math.tanh(r + combedR * 0.92)
            if (comb > 1e-4) {
                const blend = Math.min(1, comb * 4)
                l += ((l + combedL) * 0.5 - l) * blend
                r += ((r + combedR) * 0.5 - r) * blend
            }
            if (filter > 1e-4) {
                if ((i & 15) === 0) this.design(filter)
                const blend = Math.min(1, filter * 20)
                l += (this.lowpass(0, l) - l) * blend
                r += (this.lowpass(2, r) - r) * blend
            } else {
                this.svf.fill(0)
            }
            const step = Math.floor(position / 240) & 15
            const gateTarget = playing && GATE_PATTERN[step] === 0 ? 1 - gate : 1
            this.gate += (gateTarget - this.gate) * this.smoothing * 0.5
            l *= this.gate
            r *= this.gate
            this.echoTime += (Math.min(this.echoMask - 4, 0.75 * 60 / tempo * sampleRate) - this.echoTime) * 0.0005
            const echoedL = this.readLine(this.echoL, this.echoMask, this.echoTime)
            const echoedR = this.readLine(this.echoR, this.echoMask, this.echoTime)
            const feedback = 0.35 + echo * 0.5
            this.echoDamp[0] += (echoedR - this.echoDamp[0]) * 0.35
            this.echoDamp[1] += (echoedL - this.echoDamp[1]) * 0.35
            this.echoL[this.write & this.echoMask] = (l + r) * 0.5 * echo + this.echoDamp[0] * feedback
            this.echoR[this.write & this.echoMask] = this.echoDamp[1] * feedback
            l += echoedL
            r += echoedR
            const send = (l + r) * 0.5 * space
            l += this.reverb(0, send, space) * 0.6
            r += this.reverb(1, send, space) * 0.6
            outL[i] = inL + (l - inL) * this.mix
            outR[i] = inR + (r - inR) * this.mix
            this.write++
        }
        this.write &= this.echoMask
        if (this.streams.state.active) {
            this.streams.state[0] = this.rotation
            this.streams.state.set(this.amounts, 1)
        }
    }
    readShapes() {
        const shapes = this.shapes
        const position = this.rotation * RESOLUTION
        const floor = Math.floor(position) % RESOLUTION, next = (floor + 1) % RESOLUTION, fraction = position - Math.floor(position)
        for (let index = 0; index < EFFECTS.length; index++) {
            const offset = index * RESOLUTION
            const a = shapes[offset + floor], b = shapes[offset + next]
            const target = clampUnit(a + (b - a) * fraction)
            this.amounts[index] += (target - this.amounts[index]) * this.smoothing
        }
    }
    readLine(line, mask, delay) {
        const position = this.write - delay
        const index = Math.floor(position), fraction = position - index
        const a = line[index & mask], b = line[(index + 1) & mask]
        return a + (b - a) * fraction
    }
    design(amount) {
        const frequency = Math.min(20000 * Math.pow(2, -amount * 7), sampleRate * 0.45)
        const g = Math.tan(Math.PI * frequency / sampleRate)
        this.k = 2 - amount * 1.7
        this.a1 = 1 / (1 + g * (g + this.k))
        this.a2 = g * this.a1
        this.a3 = g * this.a2
    }
    lowpass(offset, input) {
        const state = this.svf
        const v3 = input - state[offset + 1]
        const v1 = this.a1 * state[offset] + this.a2 * v3
        const v2 = state[offset + 1] + this.a2 * state[offset] + this.a3 * v3
        state[offset] = 2 * v1 - state[offset]
        state[offset + 1] = 2 * v2 - state[offset + 1]
        return v2
    }
    reverb(side, input, amount) {
        const room = 0.8 + amount * 0.16, damp = 0.3
        let sum = 0
        for (const comb of this.combs[side]) {
            const output = comb.buffer[comb.index]
            comb.filter = output * (1 - damp) + comb.filter * damp
            comb.buffer[comb.index] = input * 0.25 + comb.filter * room
            comb.index = (comb.index + 1) % comb.buffer.length
            sum += output
        }
        for (const allpass of this.allpasses[side]) {
            const buffered = allpass.buffer[allpass.index]
            allpass.buffer[allpass.index] = sum + buffered * 0.5
            allpass.index = (allpass.index + 1) % allpass.buffer.length
            sum = buffered - sum
        }
        return sum
    }
}

class View {
    selected = 0
    rotation = 0
    amounts = new Float32Array(EFFECTS.length)
    stroke = null
    pointer = null
    frame = 0
    snap = 0
    constructor(host) {
        this.host = host
        const windowed = host.mode === "window"
        host.root.style.cssText = `box-sizing: border-box; margin: 1px; width: calc(100% - 2px); height: calc(100% - 2px); display: grid; grid-template-rows: minmax(0, 1fr) 13px; gap: 3px ${windowed ? 16 : 8}px`
        const style = document.createElement("style")
        style.textContent = `.button { display: flex; justify-content: center; min-width: 0; font-size: 9px; line-height: 13px; border-radius: 3px; cursor: pointer; user-select: none; white-space: nowrap; overflow: hidden; color: rgba(255, 255, 255, 0.3) }
.button:hover { color: rgba(255, 255, 255, 0.6) }
.button.active { color: ${host.color("displayStroke")} }
.button svg { display: block; width: 9px; height: 9px; margin: 2px 0 }
.row { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: 4px; height: 11px; font-size: 9px; cursor: pointer; user-select: none; color: rgba(255, 255, 255, 0.3) }
.row.active { color: ${host.color("displayStroke")} }
.row canvas { width: 100%; height: 3px; display: block; border-radius: 1px }
.mix { color: ${host.color("orange", 0.7)}; cursor: ew-resize; touch-action: none }
.mix .track { height: 3px; border-radius: 1px; background: ${host.color("orange", 0.15)} }
.mix .fill { height: 100%; border-radius: 1px; background: ${host.color("orange", 0.9)} }`
        host.root.append(style)
        this.wheel = document.createElement("canvas")
        this.wheel.style.cssText = "grid-column: 1; grid-row: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; display: block; border-radius: 4px; touch-action: none"
        host.root.append(this.wheel)
        const bar = document.createElement("div")
        bar.style.cssText = "grid-column: 1; grid-row: 2; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); align-items: center; gap: 1px; min-width: 0"
        host.root.append(bar)
        this.createButton(bar, "Smooth the circle", ICONS.smooth, () => this.smooth())
        this.snapButton = this.createButton(bar, "Snap values (wheel steps)", ICONS.snap, () => this.cycleSnap(1))
        this.turnButton = this.createButton(bar, "Bars per turn (wheel steps)", "", () => this.cycleTurn(1))
        this.snapButton.addEventListener("wheel", event => {event.preventDefault(); this.cycleSnap(-Math.sign(event.deltaY))})
        this.turnButton.addEventListener("wheel", event => {event.preventDefault(); this.cycleTurn(-Math.sign(event.deltaY))})
        host.attachParameter(this.turnButton, "turn")
        this.createButton(bar, "Reset the circle", ICONS.reset, () => this.write(new Array(RESOLUTION).fill(0)))
        if (windowed) {
            this.createButton(bar, "Random circle", ICONS.random, () => this.randomize())
        } else {
            this.createButton(bar, "Open the large editor", ICONS.window, () => host.openWindow())
        }
        const list = document.createElement("div")
        list.style.cssText = `grid-column: 2; grid-row: 1; display: flex; flex-direction: column; justify-content: ${windowed ? "flex-start; gap: 2px" : "space-evenly"}; min-height: 0`
        host.root.append(list)
        this.rows = EFFECTS.map((name, index) => this.createRow(list, name, index))
        this.createMix(windowed ? list : host.root)
        host.data.shapes.subscribe(() => this.draw())
        host.params.turn.subscribe(() => this.updateButtons())
        host.streams.state.subscribe(values => {
            this.rotation = values[0]
            for (let index = 0; index < EFFECTS.length; index++) this.amounts[index] = values[index + 1]
            if (this.stroke !== null && this.stroke.rotation !== this.rotation) this.paint(this.pointer)
            this.draw()
        })
        new ResizeObserver(() => this.draw()).observe(this.wheel)
        new ResizeObserver(() => host.root.style.gridTemplateColumns = `${Math.max(0, host.root.clientHeight - 16)}px minmax(0, 1fr)`).observe(host.root)
        this.listenWheel()
        this.select(0)
        this.updateButtons()
    }
    createButton(parent, title, icon, onClick) {
        const button = document.createElement("div")
        button.className = "button"
        button.title = title
        button.innerHTML = icon
        button.addEventListener("click", onClick)
        parent.append(button)
        return button
    }
    createMix(parent) {
        const mix = document.createElement("div")
        mix.className = "row mix"
        mix.style.cssText = parent === this.host.root ? "grid-column: 2; grid-row: 2; height: 13px" : "margin-top: 8px"
        const label = document.createElement("div")
        label.textContent = "Mix"
        const track = document.createElement("div")
        track.className = "track"
        const fill = document.createElement("div")
        fill.className = "fill"
        track.append(fill)
        mix.append(label, track)
        parent.append(mix)
        const param = this.host.params.mix
        param.subscribe(() => fill.style.width = `${clampUnit(param.value) * 100}%`)
        fill.style.width = `${clampUnit(param.value) * 100}%`
        this.host.attachParameter(mix, "mix", {enterValue: true})
        let gesture = null
        const apply = event => {
            const bounds = track.getBoundingClientRect()
            gesture.edit(() => param.set(clampUnit((event.clientX - bounds.left) / bounds.width)))
        }
        mix.addEventListener("pointerdown", event => {
            if (event.button !== 0) return
            mix.setPointerCapture(event.pointerId)
            gesture = this.host.gesture()
            apply(event)
        })
        mix.addEventListener("pointermove", event => {if (gesture !== null) apply(event)})
        const release = () => {
            if (gesture === null) return
            gesture.end()
            gesture = null
        }
        mix.addEventListener("pointerup", release)
        mix.addEventListener("lostpointercapture", release)
    }
    createRow(list, name, index) {
        const row = document.createElement("div")
        row.className = "row"
        const label = document.createElement("div")
        label.textContent = name
        const meter = document.createElement("canvas")
        row.append(label, meter)
        row.addEventListener("click", () => this.select(index))
        list.append(row)
        return {row, meter}
    }
    select(index) {
        this.selected = index
        this.rows.forEach(({row}, position) => row.classList.toggle("active", position === index))
        this.draw()
    }
    updateButtons() {
        if (this.snap === 0) this.snapButton.innerHTML = ICONS.snap
        else this.snapButton.textContent = `÷${this.snap}`
        this.snapButton.classList.toggle("active", this.snap !== 0)
        this.turnButton.textContent = TURN_LABELS[this.turnIndex()]
        this.draw()
    }
    turnIndex() {return Math.max(0, Math.min(TURNS.length - 1, Math.round(this.host.params.turn.value)))}
    cycleSnap(delta) {
        this.snap = SNAPS[(SNAPS.indexOf(this.snap) + delta + SNAPS.length) % SNAPS.length]
        this.updateButtons()
    }
    cycleTurn(delta) {
        this.host.params.turn.set((this.turnIndex() + delta + TURNS.length) % TURNS.length)
    }
    shape() {
        const offset = this.selected * RESOLUTION
        return this.host.data.shapes.toArray().slice(offset, offset + RESOLUTION)
    }
    write(values, start = 0) {this.host.data.shapes.set(values, this.selected * RESOLUTION + start)}
    smooth() {
        const values = this.shape()
        this.write(Array.from(values, (value, index) => {
            const target = (values[(index + RESOLUTION - 1) % RESOLUTION] + values[(index + 1) % RESOLUTION]) * 0.5
            return value + (target - value) * 0.5
        }))
    }
    randomize() {
        const harmonics = Array.from({length: 4}, (ignore, order) => ({phase: Math.random(), weight: Math.random() / (order + 1)}))
        this.write(Array.from({length: RESOLUTION}, (ignore, index) => {
            const unit = index / RESOLUTION
            const sum = harmonics.reduce((total, {phase, weight}, order) => total + Math.sin((unit * (order + 1) + phase) * TAU) * weight, 0)
            return this.snapValue(clampUnit(0.45 + sum * 0.5))
        }))
    }
    snapValue(value) {return this.snap === 0 ? value : Math.round(value * this.snap) / this.snap}
    geometry() {
        const width = this.wheel.clientWidth, height = this.wheel.clientHeight
        return {width, height, centerX: width / 2, centerY: height / 2, radius: Math.max(4, Math.min(width, height) / 2 - 2)}
    }
    polar(event) {
        const {centerX, centerY, radius} = this.geometry()
        const dx = event.offsetX - centerX, dy = event.offsetY - centerY
        return {angle: wrapUnit(Math.atan2(dx, dy) / TAU), distance: Math.sqrt(dx * dx + dy * dy) / radius}
    }
    point(angle, distance) {
        const {centerX, centerY, radius} = this.geometry()
        return {x: centerX + Math.sin(angle * TAU) * radius * distance, y: centerY + Math.cos(angle * TAU) * radius * distance}
    }
    paint(pointer) {
        const index = Math.floor(wrapUnit(pointer.angle + this.rotation) * RESOLUTION) % RESOLUTION
        const value = this.snapValue(clampUnit(1 - pointer.distance))
        const {values, dirty} = this.stroke
        const last = this.stroke.index ?? index, lastValue = this.stroke.value ?? value
        let delta = index - last
        if (delta > RESOLUTION / 2) delta -= RESOLUTION
        else if (delta < -RESOLUTION / 2) delta += RESOLUTION
        const count = Math.abs(delta)
        for (let step = 0; step <= count; step++) {
            const position = (last + Math.sign(delta) * step + RESOLUTION) % RESOLUTION
            values[position] = count === 0 ? value : lastValue + (value - lastValue) * step / count
            dirty[position] = 1
        }
        this.stroke.index = index
        this.stroke.value = value
        this.stroke.rotation = this.rotation
        this.draw()
    }
    flush() {
        if (this.stroke === null || !this.stroke.dirty.includes(1)) return
        const {values, dirty, gesture} = this.stroke
        gesture.edit(() => {
            let start = -1
            for (let index = 0; index <= RESOLUTION; index++) {
                if (index < RESOLUTION && dirty[index] === 1) {
                    if (start === -1) start = index
                } else if (start !== -1) {
                    this.write(values.slice(start, index), start)
                    start = -1
                }
            }
        })
        dirty.fill(0)
    }
    listenWheel() {
        const release = () => {
            if (this.stroke === null) return
            this.flush()
            this.stroke.gesture.end()
            this.stroke = null
            this.pointer = null
            this.draw()
        }
        this.wheel.addEventListener("pointerdown", event => {
            if (event.button !== 0) return
            const pointer = this.polar(event)
            if (pointer.distance > 1) return
            this.wheel.setPointerCapture(event.pointerId)
            this.stroke = {gesture: this.host.gesture(), values: this.shape(), dirty: new Uint8Array(RESOLUTION), index: null, value: null, rotation: this.rotation}
            this.pointer = pointer
            this.paint(pointer)
        })
        this.wheel.addEventListener("pointermove", event => {
            if (this.stroke === null) {
                this.wheel.style.cursor = this.polar(event).distance <= 1 ? "crosshair" : "default"
                return
            }
            this.pointer = this.polar(event)
            this.paint(this.pointer)
        })
        this.wheel.addEventListener("pointerup", release)
        this.wheel.addEventListener("lostpointercapture", release)
    }
    draw() {
        if (this.frame !== 0) return
        this.frame = requestAnimationFrame(() => {
            this.frame = 0
            this.flush()
            this.drawWheel()
            this.rows.forEach(({meter}, index) => this.drawMeter(meter, index))
        })
    }
    prepare(canvas) {
        const ratio = devicePixelRatio
        const width = canvas.clientWidth, height = canvas.clientHeight
        canvas.width = width * ratio
        canvas.height = height * ratio
        const context = canvas.getContext("2d")
        context.scale(ratio, ratio)
        context.lineWidth = 1
        return {context, width, height}
    }
    drawWheel() {
        const {context} = this.prepare(this.wheel)
        const {centerX, centerY, radius} = this.geometry()
        const host = this.host
        const rings = this.snap === 0 ? 4 : this.snap
        context.strokeStyle = host.color("displayGrid", 0.12)
        for (let ring = 1; ring < rings; ring++) {
            context.beginPath()
            context.arc(centerX, centerY, radius * ring / rings, 0, TAU)
            context.stroke()
        }
        context.strokeStyle = host.color("displayStroke", 0.25)
        context.beginPath()
        context.arc(centerX, centerY, radius + 0.5, 0, TAU)
        context.stroke()
        const shape = this.shape()
        context.beginPath()
        for (let index = 0; index < RESOLUTION; index++) {
            const {x, y} = this.point(index / RESOLUTION - this.rotation, 1 - shape[index])
            if (index === 0) context.moveTo(x, y)
            else context.lineTo(x, y)
        }
        context.closePath()
        const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius)
        gradient.addColorStop(0, host.color("displayStroke", 0.04))
        gradient.addColorStop(1, host.color("displayStroke", 0.25))
        context.fillStyle = gradient
        context.fill()
        context.strokeStyle = host.color("displayStroke", 0.85)
        context.stroke()
        context.setLineDash([1, 2])
        context.strokeStyle = host.color("displayStroke", 0.5)
        context.beginPath()
        context.moveTo(centerX + 0.5, centerY)
        context.lineTo(centerX + 0.5, centerY + radius)
        context.stroke()
        context.setLineDash([])
        const value = this.point(0, 1 - this.amounts[this.selected])
        context.fillStyle = this.stroke === null ? host.color("white") : host.color("red")
        context.beginPath()
        context.arc(value.x, value.y, 1.5, 0, TAU)
        context.fill()
    }
    drawMeter(canvas, index) {
        const {context, width, height} = this.prepare(canvas)
        const host = this.host
        context.fillStyle = host.color("displayStroke", 0.08)
        context.fillRect(0, 0, width, height)
        context.fillStyle = host.color("displayStroke", index === this.selected ? 0.9 : 0.5)
        context.fillRect(0, 0, this.amounts[index] * width, height)
    }
}
