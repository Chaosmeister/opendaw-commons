// @label XY Filter
// @param cutoff 1000 20 20000 exp Hz [omit-default-ui]
// @param resonance 0.707 0.1 10 exp [omit-default-ui]
// @param order 1 0 3 int [omit-default-ui]
// @param mode 0 0 2 int [omit-default-ui]
// @view 1 1 5 3

const MIN_FREQUENCY = 20
const MAX_FREQUENCY = 20000
const MIN_Q = 0.1
const MAX_Q = 10
// the pad's vertical axis in dB: every filter is designed so |H| at the cutoff equals Q, the curve runs through the
// handle (the 6dB filters have no resonance and stay at -3dB)
const MAX_DB = 20
const MIN_DB = -20
const UPDATE_INTERVAL = 16
const SOURCE_COLORS = {automated: "blue", modulated: "green", midi: "orange", external: "purple"}
const ORDERS = ["6", "12", "24", "48"]
const MODES = ["LP", "HP", "BP"]
const LOWPASS = 0, HIGHPASS = 1, BANDPASS = 2
// butterworth pole pair Qs per order, the 6dB filters are a single pole
const BUTTERWORTH = [[], [Math.SQRT1_2], [0.5411961, 1.3065630], [0.5097956, 0.6013449, 0.8999762, 2.5629154]]
const BANDPASS_STAGES = [1, 2, 4, 8]
const MAX_STAGES = 8

const unitOf = (value, min, max) => Math.log(value / min) / Math.log(max / min)
const valueOf = (unit, min, max) => min * Math.pow(max / min, Math.max(0, Math.min(1, unit)))

const biquad = (coefficients, offset, frequency, q, rate, mode, gain = 1) => {
    const w0 = 2 * Math.PI * Math.min(frequency, rate * 0.49) / rate
    const alpha = Math.sin(w0) / (2 * q)
    const cos = Math.cos(w0)
    const a0 = 1 + alpha
    if (mode === BANDPASS) {
        coefficients[offset] = alpha * gain / a0
        coefficients[offset + 1] = 0
        coefficients[offset + 2] = -alpha * gain / a0
    } else {
        const edge = mode === HIGHPASS ? (1 + cos) / 2 : (1 - cos) / 2
        coefficients[offset] = edge / a0
        coefficients[offset + 1] = (mode === HIGHPASS ? -2 : 2) * edge / a0
        coefficients[offset + 2] = edge / a0
    }
    coefficients[offset + 3] = -2 * cos / a0
    coefficients[offset + 4] = (1 - alpha) / a0
}

const onePole = (coefficients, frequency, rate, mode) => {
    const k = Math.tan(Math.PI * Math.min(frequency, rate * 0.49) / rate)
    coefficients[0] = (mode === HIGHPASS ? 1 : k) / (1 + k)
    coefficients[1] = mode === HIGHPASS ? -coefficients[0] : coefficients[0]
    coefficients[2] = 0
    coefficients[3] = (k - 1) / (k + 1)
    coefficients[4] = 0
}

// writes every stage and returns how many there are. A biquad has |H| = Q at its cutoff (a bandpass 1, its peak),
// so the bandpass stages share the gain and the last pass stage takes the Q the butterworth stages before leave
const design = (coefficients, mode, order, frequency, resonance, rate) => {
    if (mode === BANDPASS) {
        const stages = BANDPASS_STAGES[order]
        const gain = Math.pow(resonance, 1 / stages)
        for (let stage = 0; stage < stages; stage++) biquad(coefficients, stage * 5, frequency, resonance, rate, mode, gain)
        return stages
    }
    if (order === 0) {
        onePole(coefficients, frequency, rate, mode)
        return 1
    }
    const qs = BUTTERWORTH[order]
    const last = qs.length - 1
    const fixed = qs.slice(0, last).reduce((product, q) => product * q, 1)
    qs.forEach((q, stage) => biquad(coefficients, stage * 5, frequency, stage === last ? resonance / fixed : q, rate, mode))
    return qs.length
}

const magnitudeAt = (coefficients, stages, frequency, rate) => {
    const w = 2 * Math.PI * frequency / rate
    const cos1 = Math.cos(w), sin1 = Math.sin(w), cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w)
    let magnitude = 1
    for (let stage = 0; stage < stages; stage++) {
        const [b0, b1, b2, a1, a2] = coefficients.subarray(stage * 5, stage * 5 + 5)
        const numeratorRe = b0 + b1 * cos1 + b2 * cos2, numeratorIm = -(b1 * sin1 + b2 * sin2)
        const denominatorRe = 1 + a1 * cos1 + a2 * cos2, denominatorIm = -(a1 * sin1 + a2 * sin2)
        magnitude *= Math.sqrt((numeratorRe ** 2 + numeratorIm ** 2) / (denominatorRe ** 2 + denominatorIm ** 2))
    }
    return magnitude
}

const formatFrequency = frequency => frequency >= 1000 ? `${(frequency / 1000).toFixed(2)} kHz` : `${Math.round(frequency)} Hz`

class Processor {
    coefficients = new Float64Array(MAX_STAGES * 5)
    states = new Float64Array(MAX_STAGES * 4)
    stages = 1
    primed = false
    cutoff = 1000; resonance = 0.707; order = 1; mode = 0
    cutoffTarget = 1000; resonanceTarget = 0.707
    paramChanged(label, value) {
        if (label === "cutoff") this.cutoffTarget = value
        else if (label === "resonance") this.resonanceTarget = value
        else if (label === "order" || label === "mode") {
            this[label] = Math.round(value)
            this.states.fill(0)
            this.redesign()
        }
    }
    reset() {this.states.fill(0)}
    redesign() {this.stages = design(this.coefficients, this.mode, this.order, this.cutoff, this.resonance, sampleRate)}
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const c = this.coefficients, s = this.states
        if (!this.primed) {
            this.primed = true
            this.cutoff = this.cutoffTarget
            this.resonance = this.resonanceTarget
            this.redesign()
        }
        for (let i = s0; i < s1; i++) {
            // glide in the log domain every few samples: no zipper noise when automated or dragged
            if ((i - s0) % UPDATE_INTERVAL === 0) {
                this.cutoff *= Math.pow(this.cutoffTarget / this.cutoff, 0.05)
                this.resonance *= Math.pow(this.resonanceTarget / this.resonance, 0.05)
                this.redesign()
            }
            let left = srcL[i], right = srcR[i]
            for (let stage = 0; stage < this.stages; stage++) {
                const k = stage * 5, z = stage * 4
                const filteredL = c[k] * left + s[z]
                s[z] = c[k + 1] * left - c[k + 3] * filteredL + s[z + 1]
                s[z + 1] = c[k + 2] * left - c[k + 4] * filteredL
                const filteredR = c[k] * right + s[z + 2]
                s[z + 2] = c[k + 1] * right - c[k + 3] * filteredR + s[z + 3]
                s[z + 3] = c[k + 2] * right - c[k + 4] * filteredR
                left = filteredL
                right = filteredR
            }
            outL[i] = left
            outR[i] = right
        }
    }
}

class View {
    gesture = null
    hovered = false
    options = []
    constructor(host) {
        this.host = host
        this.coefficients = new Float64Array(MAX_STAGES * 5)
        host.root.style.cssText = `box-sizing: border-box; margin: 1px; width: calc(100% - 2px); height: calc(100% - 2px); padding: 4px; border: 0.5px solid ${host.color("displayGrid", 0.12)}; border-radius: 8px; display: grid; grid-template-columns: 8px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 8px; gap: 3px`
        this.pad = this.createCanvas(2, 1, "crosshair")
        this.resonanceScale = this.createCanvas(1, 1, "ns-resize")
        this.cutoffScale = this.createCanvas(2, 2, "ew-resize")
        // the scales carry the parameter menus, a right click on them opens automation, modulation and MIDI learn
        host.attachParameter(this.cutoffScale, "cutoff")
        host.attachParameter(this.resonanceScale, "resonance")
        for (const name of ["cutoff", "resonance", "order", "mode"]) {
            host.params[name].subscribe(() => this.draw())
            host.params[name].subscribeSources(() => this.draw())
        }
        const observer = new ResizeObserver(() => this.draw())
        for (const canvas of [this.pad, this.cutoffScale, this.resonanceScale]) observer.observe(canvas)
        this.pad.addEventListener("pointerdown", event => {
            const option = this.optionAt(event)
            if (option === undefined || event.button !== 0) return
            event.stopImmediatePropagation()
            this.host.edit(() => this.host.params[option.name].set(option.value))
        })
        this.pad.addEventListener("pointermove", event => {
            if (this.gesture === null) this.pad.style.cursor = this.optionAt(event) === undefined ? "crosshair" : "pointer"
        })
        this.listen(this.pad, true, true)
        this.listen(this.cutoffScale, true, false)
        this.listen(this.resonanceScale, false, true)
        this.pad.addEventListener("pointerenter", () => {this.hovered = true; this.draw()})
        this.pad.addEventListener("pointerleave", () => {this.hovered = false; this.draw()})
    }
    optionAt({offsetX, offsetY}) {
        return this.options.find(({left, right, top, bottom}) => offsetX >= left && offsetX <= right && offsetY >= top && offsetY <= bottom)
    }
    createCanvas(column, row, cursor) {
        const canvas = document.createElement("canvas")
        canvas.style.cssText = `grid-column: ${column}; grid-row: ${row}; width: 100%; height: 100%; min-width: 0; min-height: 0; display: block; border-radius: 4px; touch-action: none; cursor: ${cursor}`
        this.host.root.append(canvas)
        return canvas
    }
    listen(canvas, horizontal, vertical) {
        const apply = event => this.gesture.edit(() => {
            if (horizontal) this.host.params.cutoff.set(valueOf(event.offsetX / canvas.clientWidth, MIN_FREQUENCY, MAX_FREQUENCY))
            if (vertical) this.host.params.resonance.set(valueOf(1 - event.offsetY / canvas.clientHeight, MIN_Q, MAX_Q))
        })
        const release = () => {
            if (this.gesture === null) return
            this.gesture.end()
            this.gesture = null
        }
        canvas.addEventListener("pointerdown", event => {
            if (event.button !== 0) return
            canvas.setPointerCapture(event.pointerId)
            this.gesture = this.host.gesture()
            apply(event)
        })
        canvas.addEventListener("pointermove", event => {if (this.gesture !== null) apply(event)})
        canvas.addEventListener("pointerup", release)
        canvas.addEventListener("lostpointercapture", release)
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
    draw() {
        this.drawPad()
        this.drawScale(this.cutoffScale, this.host.params.cutoff, MIN_FREQUENCY, MAX_FREQUENCY, true)
        this.drawScale(this.resonanceScale, this.host.params.resonance, MIN_Q, MAX_Q, false)
    }
    drawPad() {
        const {context, width, height} = this.prepare(this.pad)
        const cutoff = this.host.params.cutoff.value, resonance = this.host.params.resonance.value
        const xOf = frequency => unitOf(frequency, MIN_FREQUENCY, MAX_FREQUENCY) * width
        const yOf = decibel => (MAX_DB - decibel) / (MAX_DB - MIN_DB) * height
        context.strokeStyle = this.host.color("displayStroke", 0.25)
        context.setLineDash([2, 2])
        context.beginPath()
        const zero = Math.round(yOf(0)) + 0.5
        context.moveTo(0, zero)
        context.lineTo(width, zero)
        context.stroke()
        context.setLineDash([])
        const order = Math.round(this.host.params.order.value), mode = Math.round(this.host.params.mode.value)
        const stages = design(this.coefficients, mode, order, cutoff, resonance, sampleRate)
        const curve = new Path2D()
        for (let x = 0; x <= width; x++) {
            const magnitude = magnitudeAt(this.coefficients, stages, valueOf(x / width, MIN_FREQUENCY, MAX_FREQUENCY), sampleRate)
            const y = Math.min(height + 1, yOf(20 * Math.log10(magnitude + 1e-9)))
            x === 0 ? curve.moveTo(x, y) : curve.lineTo(x, y)
        }
        const area = new Path2D(curve)
        area.lineTo(width, height + 1)
        area.lineTo(0, height + 1)
        const gradient = context.createLinearGradient(0, 0, 0, height)
        gradient.addColorStop(0, this.host.color("displayStroke", 0.25))
        gradient.addColorStop(1, this.host.color("displayStroke", 0))
        context.fillStyle = gradient
        context.fill(area)
        context.strokeStyle = this.host.color("displayStroke", 0.9)
        context.stroke(curve)
        const handleX = xOf(cutoff), handleY = yOf(20 * Math.log10(magnitudeAt(this.coefficients, stages, cutoff, sampleRate)))
        context.beginPath()
        context.arc(handleX, handleY, 5, 0, Math.PI * 2)
        context.fillStyle = this.host.color("displayStroke", this.gesture !== null ? 0.5 : 0.2)
        context.fill()
        context.strokeStyle = this.host.color("displayStroke", 1)
        context.stroke()
        context.font = `9px ${getComputedStyle(this.pad).fontFamily}`
        context.fillStyle = "rgba(255, 255, 255, 0.2)"
        // values align right at fixed columns, so the readout keeps its place while the digits change
        const frequencyRight = 4 + context.measureText("00.00 kHz").width
        const qRight = frequencyRight + 8 + context.measureText("00.00").width
        context.textAlign = "right"
        context.fillText(formatFrequency(cutoff), frequencyRight, 11)
        context.fillText(resonance.toFixed(2), qRight, 11)
        context.textAlign = "left"
        context.fillText(" Q", qRight, 11)
        if (this.hovered) context.fillText("Right-click a scale for its menu", 4, height - 4)
        this.options = []
        this.drawOptions(context, width - 4, 11, "mode", MODES, mode)
        this.drawOptions(context, width - 4, 23, "order", ORDERS, order, "dB")
    }
    drawOptions(context, right, baseline, name, labels, selected, unit = "") {
        context.textAlign = "left"
        const unitWidth = unit === "" ? 0 : context.measureText(unit).width + 3
        let x = right - unitWidth - labels.reduce((sum, label) => sum + context.measureText(label).width, 0) - (labels.length - 1) * 6
        labels.forEach((label, value) => {
            const labelWidth = context.measureText(label).width
            context.fillStyle = value === selected ? this.host.color("displayStroke", 0.9) : "rgba(255, 255, 255, 0.2)"
            context.fillText(label, x, baseline)
            this.options.push({name, value, left: x - 3, right: x + labelWidth + 3, top: baseline - 10, bottom: baseline + 2})
            x += labelWidth + 6
        })
        if (unit === "") return
        context.fillStyle = "rgba(255, 255, 255, 0.2)"
        context.fillText(unit, right - unitWidth + 3, baseline)
    }
    drawScale(canvas, parameter, min, max, horizontal) {
        const {context, width, height} = this.prepare(canvas)
        const source = Object.keys(SOURCE_COLORS).find(key => parameter.sources.includes(key))
        const paint = source === undefined ? "displayStroke" : SOURCE_COLORS[source]
        const unit = unitOf(parameter.value, min, max)
        context.fillStyle = this.host.color(paint, 0.06)
        context.fillRect(0, 0, width, height)
        context.fillStyle = this.host.color(paint, 0.25)
        if (horizontal) {
            context.fillRect(0, 0, unit * width, height)
        } else {
            context.fillRect(0, (1 - unit) * height, width, unit * height)
        }
        context.fillStyle = this.host.color(paint, 0.9)
        if (horizontal) {
            context.fillRect(Math.round(unit * width) - 1, 0, 2, height)
        } else {
            context.fillRect(0, Math.round((1 - unit) * height) - 1, width, 2)
        }
    }
}
