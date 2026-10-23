// @label C64 SID
// @param triangle   false                       [omit-default-ui]
// @param sawtooth   true                        [omit-default-ui]
// @param pulse      false                       [omit-default-ui]
// @param noise      false                       [omit-default-ui]
// @param width      2048  0     4095   int      [omit-default-ui]
// @param sync       false                       [omit-default-ui]
// @param ring       false                       [omit-default-ui]
// @param interval   12    -24   24     int     st [omit-default-ui]
// @param detune     0     -100  100    linear  ct [omit-default-ui]
// @param attack     0     0     15     int      [omit-default-ui]
// @param decay      9     0     15     int      [omit-default-ui]
// @param sustain    10    0     15     int      [omit-default-ui]
// @param release    4     0     15     int      [omit-default-ui]
// @param filter     true                        [omit-default-ui]
// @param cutoff     1024  0     2047   int      [omit-default-ui]
// @param resonance  8     0     15     int      [omit-default-ui]
// @param lowpass    true                        [omit-default-ui]
// @param bandpass   false                       [omit-default-ui]
// @param highpass   false                       [omit-default-ui]
// @param mos8580    false                       [omit-default-ui]
// @param volume     15    0     15     int      [omit-default-ui]
// @param velocity   0.5   0     1      linear   [omit-default-ui]
// @view SidView 1 1 10 3
// @stream scope 512 ring

// PAL phi2 clock in Hz
const CLOCK = 985248
const RATE_PERIODS = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251]
// reSID 0.16 measured cutoff curves: register, Hz
const CUTOFF_6581 = [0, 220, 128, 230, 256, 250, 384, 300, 512, 420, 640, 780, 768, 1600, 832, 2300, 896, 3200,
    960, 4300, 992, 5000, 1008, 5400, 1016, 5700, 1023, 6000, 1024, 4600, 1032, 4800, 1056, 5300, 1088, 6000,
    1120, 6600, 1152, 7200, 1280, 9500, 1408, 12000, 1536, 14500, 1664, 16000, 1792, 17100, 1920, 17700, 2047, 18000]
const CUTOFF_8580 = [0, 30, 128, 800, 256, 1600, 384, 2500, 512, 3300, 640, 4100, 768, 4800, 896, 5600, 1024, 6500,
    1152, 7500, 1280, 8400, 1408, 9200, 1536, 9800, 1664, 10500, 1792, 11000, 1920, 11700, 2047, 12500]
// 8th order Butterworth sections
const DECIMATOR_Q = [0.5098, 0.6013, 0.9000, 2.5629]
const ATTACK = 0
const DECAY = 1
const RELEASE = 2

function noteHz(pitch, cent) {return 440 * Math.pow(2, (pitch - 69 + cent / 100) / 12)}

function frequencyRegister(hz) {return Math.max(0, Math.min(0xFFFF, Math.round(hz * 16777216 / CLOCK)))}

function cutoffHz(mos8580, register) {
    const points = mos8580 ? CUTOFF_8580 : CUTOFF_6581
    let segment = 0
    while (segment < points.length - 4 && register >= points[segment + 2]) {segment += 2}
    const [x0, y0, x1, y1] = [points[segment], points[segment + 1], points[segment + 2], points[segment + 3]]
    return x1 === x0 ? y1 : y0 + (y1 - y0) * (register - x0) / (x1 - x0)
}

function filterDamping(mos8580, resonance) {
    return mos8580 ? Math.pow(2, (4 - resonance) / 8) : Math.max(1 / 16, (15 - resonance) / 8)
}

function cutoffTable(mos8580, rate) {
    const table = new Float32Array(2048)
    for (let register = 0; register < 2048; register++) {
        table[register] = 2 * Math.sin(Math.PI * Math.min(cutoffHz(mos8580, register), rate / 6) / rate)
    }
    return table
}

// jsSID by Hermit: neighbouring DAC bits pull each other across the threshold
function combinedWaveform(bitMul, bitStrength, threshold) {
    const table = new Uint16Array(4096)
    for (let index = 0; index < 4096; index++) {
        let value = 0
        for (let bit = 0; bit < 12; bit++) {
            let level = 0
            for (let other = 0; other < 12; other++) {
                level += bitMul / Math.pow(bitStrength, Math.abs(other - bit)) * (((index >> other) & 1) - 0.5)
            }
            if (level >= threshold) {value |= 1 << bit}
        }
        table[index] = value
    }
    return table
}

function lowpassBiquad(hz, q, rate) {
    const omega = 2 * Math.PI * hz / rate
    const alpha = Math.sin(omega) / (2 * q)
    const cos = Math.cos(omega)
    const a0 = 1 + alpha
    return {b0: (1 - cos) / 2 / a0, b1: (1 - cos) / a0, b2: (1 - cos) / 2 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0, z1: 0, z2: 0}
}

class Voice {
    constructor(pitch, cent, id, gain, shift) {
        this.pitch = pitch
        this.cent = cent
        this.id = id
        this.gain = gain
        this.accumulator = 0
        this.modulator = 0
        this.carrierStep = 0
        this.modulatorStep = 0
        this.shift = shift
        this.last = 0x800
        this.envelope = 0
        this.state = ATTACK
        this.holdZero = false
        this.rate = 0
        this.expCounter = 0
        this.expPeriod = 1
        this.clockFraction = 0
        this.fastRelease = false
        this.vhp = 0
        this.vbp = 0
        this.vlp = 0
    }
    gateOn(id, gain) {
        // hard restart: a retrigger would otherwise wait up to 33 ms for the rate counter to wrap (ADSR bug)
        this.rate = 0
        this.id = id
        this.gain = gain
        this.state = ATTACK
        this.holdZero = false
        this.fastRelease = false
    }
    gateOff() {this.state = RELEASE}
    get finished() {return this.state === RELEASE && this.envelope === 0}
    clockEnvelope(sid, clocks) {
        this.clockFraction += clocks
        let count = Math.floor(this.clockFraction)
        this.clockFraction -= count
        while (count > 0) {
            const index = this.state === ATTACK ? sid.attack : this.state === DECAY ? sid.decay : this.fastRelease ? 0 : sid.release
            const period = RATE_PERIODS[index]
            if (this.rate < period) {
                const need = period - this.rate
                if (need > count) {this.rate += count; return}
                count -= need
                this.rate = 0
                this.tickEnvelope(sid)
            } else {
                // the 15-bit rate counter overshot the new period and has to wrap first (ADSR bug)
                const need = 0x8000 - this.rate
                if (need > count) {this.rate += count; return}
                count -= need
                this.rate = 0
            }
        }
    }
    tickEnvelope(sid) {
        if (this.state !== ATTACK && ++this.expCounter !== this.expPeriod) {return}
        this.expCounter = 0
        if (this.holdZero) {return}
        if (this.state === ATTACK) {
            this.envelope = (this.envelope + 1) & 0xFF
            if (this.envelope === 0xFF) {this.state = DECAY}
        } else if (this.state === DECAY) {
            if (this.envelope !== sid.sustain * 0x11) {this.envelope = (this.envelope - 1) & 0xFF}
        } else {
            this.envelope = (this.envelope - 1) & 0xFF
        }
        switch (this.envelope) {
            case 0xFF: this.expPeriod = 1; break
            case 0x5D: this.expPeriod = 2; break
            case 0x36: this.expPeriod = 4; break
            case 0x1A: this.expPeriod = 8; break
            case 0x0E: this.expPeriod = 16; break
            case 0x06: this.expPeriod = 30; break
            case 0x00: this.expPeriod = 1; this.holdZero = true; break
        }
    }
    tune(sid) {
        const offset = sid.interval * 100 + sid.detune
        this.carrierStep = frequencyRegister(noteHz(this.pitch, this.cent + (sid.sync ? offset : 0))) * sid.clocksPerStep
        this.modulatorStep = frequencyRegister(noteHz(this.pitch, this.cent + (sid.sync ? 0 : offset))) * sid.clocksPerStep
    }
    render(sid, buffer, from, to) {
        const {carrierStep, modulatorStep} = this
        const {waveform, width, sync, ring, mos8580, filter} = sid
        const select = waveform & 0x70
        const noise = (waveform & 0x80) !== 0
        const mask = mos8580 ? 0xFFF : 0x7FF
        const zero = mos8580 ? 0x800 : 0x380
        const cutoff = sid.cutoffs[sid.cutoff]
        const damping = filterDamping(mos8580, sid.resonance)
        const scale = this.envelope / 255 / 2048 * this.gain
        for (let index = from; index < to; index++) {
            const modulatorBefore = this.modulator
            this.modulator += modulatorStep
            if (this.modulator >= 0x1000000) {this.modulator -= 0x1000000}
            const before = this.accumulator | 0
            this.accumulator += carrierStep
            if (this.accumulator >= 0x1000000) {this.accumulator -= 0x1000000}
            if (sync && modulatorBefore < 0x800000 && this.modulator >= 0x800000) {this.accumulator = 0}
            const accumulator = this.accumulator | 0
            if ((before & 0x80000) === 0 && (accumulator & 0x80000) !== 0) {
                const shift = this.shift
                this.shift = ((shift << 1) | (((shift >> 22) ^ (shift >> 17)) & 1)) & 0x7FFFFF
            }
            let wave = this.last
            if (waveform !== 0) {
                const saw = accumulator >> 12
                const ringed = ring ? accumulator ^ (~this.modulator & 0x800000) : accumulator
                const triangle = (((ringed & 0x800000) !== 0 ? ringed ^ 0xFFFFFF : ringed) >> 11) & 0xFFE
                const pulse = saw >= width ? 0xFFF : 0
                switch (select) {
                    case 0x10: wave = triangle; break
                    case 0x20: wave = saw; break
                    case 0x30: wave = sid.triSaw[saw & mask]; break
                    case 0x40: wave = pulse; break
                    case 0x50: wave = pulse & sid.pulseSaw[triangle]; break
                    case 0x60: wave = pulse & sid.pulseSaw[saw & mask]; break
                    case 0x70: wave = pulse & sid.pulseTriSaw[saw & mask]; break
                    default: wave = 0xFFF
                }
                if (noise) {
                    const shift = this.shift
                    const noiseOut = ((shift & 0x100000) >> 9) | ((shift & 0x040000) >> 8) | ((shift & 0x004000) >> 5)
                        | ((shift & 0x000800) >> 3) | ((shift & 0x000200) >> 2) | ((shift & 0x000020) << 1)
                        | ((shift & 0x000004) << 3) | ((shift & 0x000001) << 4)
                    wave &= noiseOut
                }
                this.last = wave
            }
            const input = (wave - zero) * scale
            if (filter) {
                this.vbp -= cutoff * this.vhp
                this.vlp -= cutoff * this.vbp
                if (!mos8580 && Math.abs(this.vbp) > 1) {this.vbp = Math.sign(this.vbp) * (2 - 1 / Math.abs(this.vbp))}
                this.vhp = this.vbp * damping - this.vlp - input
                buffer[index] += (sid.lowpass ? this.vlp : 0) + (sid.bandpass ? this.vbp : 0) + (sid.highpass ? this.vhp : 0)
            } else {
                buffer[index] += input
            }
        }
    }
}

class Processor {
    constructor() {
        this.oversampling = sampleRate >= 88200 ? 2 : 4
        const rate = sampleRate * this.oversampling
        this.clocksPerStep = CLOCK / rate
        this.clocksPerSample = CLOCK / sampleRate
        this.cutoffs6581 = cutoffTable(false, rate)
        this.cutoffs8580 = cutoffTable(true, rate)
        this.cutoffs = this.cutoffs6581
        this.triSaw = combinedWaveform(0.8, 2.4, 0.64)
        this.pulseSaw = combinedWaveform(1.4, 1.9, 0.68)
        this.pulseTriSaw = combinedWaveform(0.8, 2.5, 0.64)
        this.decimator = DECIMATOR_Q.map(q => lowpassBiquad(Math.min(16000, sampleRate * 0.42), q, rate))
        this.dcBlock = 1 - Math.exp(-2 * Math.PI * 16 / sampleRate)
        this.dc = 0
        this.buffer = new Float32Array(128 * this.oversampling)
        this.voices = []
        this.seed = 0x2545F491
        this.waveform = 0x20
        this.width = 2048
        this.sync = false
        this.ring = false
        this.interval = 12
        this.detune = 0
        this.attack = 0
        this.decay = 9
        this.sustain = 10
        this.release = 4
        this.filter = true
        this.cutoff = 1024
        this.resonance = 8
        this.lowpass = true
        this.bandpass = false
        this.highpass = false
        this.mos8580 = false
        this.volume = 15
        this.velocity = 0.5
    }
    paramChanged(name, value) {
        const bit = {triangle: 0x10, sawtooth: 0x20, pulse: 0x40, noise: 0x80}[name]
        if (bit !== undefined) {
            this.waveform = value >= 0.5 ? this.waveform | bit : this.waveform & ~bit
        } else if (name === "mos8580") {
            this.mos8580 = value >= 0.5
            this.cutoffs = this.mos8580 ? this.cutoffs8580 : this.cutoffs6581
        } else if (["sync", "ring", "filter", "lowpass", "bandpass", "highpass"].includes(name)) {
            this[name] = value >= 0.5
        } else if (name === "detune" || name === "velocity") {
            this[name] = value
        } else {
            this[name] = Math.round(value)
        }
    }
    noteOn(pitch, velocity, cent, id) {
        const gain = 1 - this.velocity * (1 - velocity)
        const voice = this.voices.find(voice => voice.pitch === pitch && voice.cent === cent && voice.state === RELEASE)
        if (voice !== undefined) {
            voice.gateOn(id, gain)
        } else {
            // a register starting at all ones sounds tonal for a second, the real one runs since power-on
            this.seed ^= this.seed << 13
            this.seed ^= this.seed >>> 17
            this.seed ^= this.seed << 5
            this.voices.push(new Voice(pitch, cent, id, gain, (this.seed & 0x7FFFFF) || 1))
        }
    }
    noteOff(id) {
        const voice = this.voices.find(voice => voice.id === id && voice.state !== RELEASE)
        if (voice !== undefined) {voice.gateOff()}
    }
    reset() {
        for (const voice of this.voices) {
            voice.gateOff()
            voice.fastRelease = true
        }
    }
    process(output, block) {
        const [outL, outR] = output
        const oversampling = this.oversampling
        const length = (block.s1 - block.s0) * oversampling
        if (this.buffer.length < length) {this.buffer = new Float32Array(length)}
        const buffer = this.buffer
        buffer.fill(0, 0, length)
        for (const voice of this.voices) {
            voice.tune(this)
            for (let index = 0; index < length; index += oversampling) {
                voice.clockEnvelope(this, this.clocksPerSample)
                voice.render(this, buffer, index, index + oversampling)
            }
        }
        this.voices = this.voices.filter(voice => !voice.finished)
        const gain = this.volume / 15 * 0.35
        for (let index = 0; index < length; index++) {
            let sample = buffer[index]
            for (const section of this.decimator) {
                const result = section.b0 * sample + section.z1
                section.z1 = section.b1 * sample - section.a1 * result + section.z2
                section.z2 = section.b2 * sample - section.a2 * result
                sample = result
            }
            buffer[index] = sample
        }
        for (let frame = block.s0, index = oversampling - 1; frame < block.s1; frame++, index += oversampling) {
            this.dc += (buffer[index] - this.dc) * this.dcBlock
            const sample = (buffer[index] - this.dc) * gain
            outL[frame] += sample
            outR[frame] += sample
        }
        if (this.streams !== undefined && this.streams.scope.active) {this.streams.scope.write(outL, block.s0, block.s1)}
    }
}

const BLUE = "#352879"
const LIGHT_BLUE = "#6C5EB5"
const DIM = "rgba(108, 94, 181, 0.35)"
const ATTACK_MS = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000]
// own 8x8 glyphs in the C64 style, one byte per row, bit 7 is the left pixel
const GLYPHS = {
    "A": [0x18, 0x3C, 0x66, 0x66, 0x7E, 0x66, 0x66, 0x00], "B": [0x7C, 0x66, 0x66, 0x7C, 0x66, 0x66, 0x7C, 0x00],
    "C": [0x3C, 0x66, 0x60, 0x60, 0x60, 0x66, 0x3C, 0x00], "D": [0x78, 0x6C, 0x66, 0x66, 0x66, 0x6C, 0x78, 0x00],
    "E": [0x7E, 0x60, 0x60, 0x7C, 0x60, 0x60, 0x7E, 0x00], "F": [0x7E, 0x60, 0x60, 0x7C, 0x60, 0x60, 0x60, 0x00],
    "G": [0x3C, 0x66, 0x60, 0x6E, 0x66, 0x66, 0x3E, 0x00], "H": [0x66, 0x66, 0x66, 0x7E, 0x66, 0x66, 0x66, 0x00],
    "I": [0x3C, 0x18, 0x18, 0x18, 0x18, 0x18, 0x3C, 0x00], "J": [0x1E, 0x0C, 0x0C, 0x0C, 0x0C, 0x6C, 0x38, 0x00],
    "K": [0x66, 0x6C, 0x78, 0x70, 0x78, 0x6C, 0x66, 0x00], "L": [0x60, 0x60, 0x60, 0x60, 0x60, 0x60, 0x7E, 0x00],
    "M": [0x63, 0x77, 0x7F, 0x6B, 0x63, 0x63, 0x63, 0x00], "N": [0x66, 0x76, 0x7E, 0x7E, 0x6E, 0x66, 0x66, 0x00],
    "O": [0x3C, 0x66, 0x66, 0x66, 0x66, 0x66, 0x3C, 0x00], "P": [0x7C, 0x66, 0x66, 0x7C, 0x60, 0x60, 0x60, 0x00],
    "Q": [0x3C, 0x66, 0x66, 0x66, 0x66, 0x3C, 0x0E, 0x00], "R": [0x7C, 0x66, 0x66, 0x7C, 0x78, 0x6C, 0x66, 0x00],
    "S": [0x3C, 0x66, 0x60, 0x3C, 0x06, 0x66, 0x3C, 0x00], "T": [0x7E, 0x18, 0x18, 0x18, 0x18, 0x18, 0x18, 0x00],
    "U": [0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x3C, 0x00], "V": [0x66, 0x66, 0x66, 0x66, 0x66, 0x3C, 0x18, 0x00],
    "W": [0x63, 0x63, 0x63, 0x6B, 0x7F, 0x77, 0x63, 0x00], "X": [0x66, 0x66, 0x3C, 0x18, 0x3C, 0x66, 0x66, 0x00],
    "Y": [0x66, 0x66, 0x66, 0x3C, 0x18, 0x18, 0x18, 0x00], "Z": [0x7E, 0x06, 0x0C, 0x18, 0x30, 0x60, 0x7E, 0x00],
    "0": [0x3C, 0x66, 0x6E, 0x76, 0x66, 0x66, 0x3C, 0x00], "1": [0x18, 0x38, 0x18, 0x18, 0x18, 0x18, 0x7E, 0x00],
    "2": [0x3C, 0x66, 0x06, 0x0C, 0x30, 0x60, 0x7E, 0x00], "3": [0x3C, 0x66, 0x06, 0x1C, 0x06, 0x66, 0x3C, 0x00],
    "4": [0x0C, 0x1C, 0x3C, 0x6C, 0x7E, 0x0C, 0x0C, 0x00], "5": [0x7E, 0x60, 0x7C, 0x06, 0x06, 0x66, 0x3C, 0x00],
    "6": [0x3C, 0x66, 0x60, 0x7C, 0x66, 0x66, 0x3C, 0x00], "7": [0x7E, 0x66, 0x0C, 0x18, 0x18, 0x18, 0x18, 0x00],
    "8": [0x3C, 0x66, 0x66, 0x3C, 0x66, 0x66, 0x3C, 0x00], "9": [0x3C, 0x66, 0x66, 0x3E, 0x06, 0x66, 0x3C, 0x00],
    "+": [0x00, 0x18, 0x18, 0x7E, 0x18, 0x18, 0x00, 0x00], "-": [0x00, 0x00, 0x00, 0x7E, 0x00, 0x00, 0x00, 0x00],
    " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
}
// glyph masks are drawn at 4x so they stay sharp up to a device pixel ratio of 4
const GLYPH_SCALE = 4
const STYLE = `
.frame { margin: 1px; width: calc(100vw - 2px); height: calc(100vh - 2px); background: ${BLUE}; color: ${LIGHT_BLUE};
    user-select: none; box-sizing: border-box; padding: 3px; border-radius: 2px; display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 3px; overflow: hidden }
.stack { display: flex; flex-direction: column; gap: 3px; min-width: 0; min-height: 0 }
.stack .panel { flex: 1 }
.panel { border: 1px solid ${LIGHT_BLUE}; display: flex; flex-direction: column; gap: 3px; padding: 0 3px 3px; min-width: 0; min-height: 0 }
.pixel { display: flex; flex: none; height: 8px }
.glyph { width: 8px; height: 8px; background-color: currentColor }
.title { background: ${LIGHT_BLUE}; color: ${BLUE}; margin: 0 -3px; padding: 0 3px; height: 10px; flex: none; display: flex; align-items: center }
.row { display: flex; gap: 3px; flex: none }
.toggle { flex: 1; min-width: 0; height: 13px; box-sizing: border-box; padding-top: 2px; display: flex; align-items: flex-start; justify-content: center;
    border: 1px solid ${LIGHT_BLUE}; cursor: pointer }
.toggle.on { background: ${LIGHT_BLUE}; color: ${BLUE} }
.toggle.inert { opacity: 0.4 }
.field { flex: 1; min-width: 0; height: 12px; display: flex; align-items: center; justify-content: space-between; gap: 4px;
    cursor: ns-resize; touch-action: none }
.field .value { display: block; background: ${DIM}; padding: 2px 2px 1px }
.digits { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3px; flex: none }
.digits .field { height: 24px; flex-direction: column; justify-content: center; gap: 2px }
canvas { flex: 1; min-height: 0; width: 100%; display: block; border: 1px solid ${DIM}; box-sizing: border-box }`

function hex(value, digits) {return Math.round(value).toString(16).toUpperCase().padStart(digits, "0")}

function signed(value) {return (value < 0 ? "-" : "+") + String(Math.abs(Math.round(value))).padStart(2, "0")}

function prepare(canvas) {
    const width = canvas.clientWidth, height = canvas.clientHeight
    canvas.width = Math.max(1, Math.round(width * devicePixelRatio))
    canvas.height = Math.max(1, Math.round(height * devicePixelRatio))
    const context = canvas.getContext("2d")
    context.scale(devicePixelRatio, devicePixelRatio)
    context.strokeStyle = LIGHT_BLUE
    context.fillStyle = LIGHT_BLUE
    context.lineWidth = 1
    return {context, width, height}
}

class SidView {
    constructor(host) {
        this.host = host
        this.scopeValues = new Float32Array(512)
        this.glyphs = Object.keys(GLYPHS)
        const sheet = `url(${this.fontSheet()}) 0 0 / ${this.glyphs.length * 8}px 8px no-repeat`
        const style = document.createElement("style")
        style.textContent = `${STYLE}\n.glyph { mask: ${sheet}; -webkit-mask: ${sheet} }`
        host.root.append(style)
        this.scope = document.createElement("canvas")
        this.curve = document.createElement("canvas")
        this.response = document.createElement("canvas")
        const ring = this.toggle("ring", "Ring")
        const frame = document.createElement("div")
        frame.className = "frame"
        host.root.append(frame)
        frame.append(
            this.panel("Waveform",
                this.row(this.toggle("triangle", "Tri"), this.toggle("sawtooth", "Saw")),
                this.row(this.toggle("pulse", "Pul"), this.toggle("noise", "Noi")),
                this.row(this.field("width", "PW", 0, 4095, 4, value => hex(value, 3))),
                this.scope),
            this.stack(
                this.panel("Modulator",
                    this.row(this.toggle("sync", "Sync"), ring),
                    this.row(this.field("interval", "Int", -24, 24, 0.15, signed)),
                    this.row(this.field("detune", "Det", -100, 100, 0.5, signed, false))),
                this.panel("Chip",
                    this.row(this.modelToggle(), this.field("volume", "Vol", 0, 15, 0.08, value => hex(value, 1))),
                    this.row(this.field("velocity", "Vel", 0, 1, 0.005, value => String(Math.round(value * 99)).padStart(2, "0"), false)))),
            this.panel("Envelope",
                this.digits(["attack", "A"], ["decay", "D"], ["sustain", "S"], ["release", "R"]),
                this.curve),
            this.panel("Filter",
                this.row(this.toggle("filter", "Flt"), this.toggle("lowpass", "LP")),
                this.row(this.toggle("bandpass", "BP"), this.toggle("highpass", "HP")),
                this.row(this.field("cutoff", "Cut", 0, 2047, 4, value => hex(value, 3))),
                this.row(this.field("resonance", "Res", 0, 15, 0.08, value => hex(value, 1))),
                this.response))
        // ring modulation only reaches the triangle
        const updateRing = () => ring.classList.toggle("inert", host.params.triangle.value < 0.5)
        host.params.triangle.subscribe(updateRing)
        updateRing()
        for (const name of ["attack", "decay", "sustain", "release"]) {host.params[name].subscribe(() => this.drawCurve())}
        for (const name of ["filter", "lowpass", "bandpass", "highpass", "cutoff", "resonance", "mos8580"]) {
            host.params[name].subscribe(() => this.drawResponse())
        }
        host.streams.scope.subscribe(values => {
            this.scopeValues = values
            this.drawScope()
        })
        new ResizeObserver(() => {
            this.drawScope()
            this.drawCurve()
            this.drawResponse()
        }).observe(host.root)
    }
    panel(title, ...children) {
        const panel = document.createElement("div")
        panel.className = "panel"
        const heading = document.createElement("div")
        heading.className = "title"
        heading.append(this.pixel(title))
        panel.append(heading, ...children)
        return panel
    }
    pixel(text) {
        const element = document.createElement("span")
        element.className = "pixel"
        this.write(element, text)
        return element
    }
    fontSheet() {
        const canvas = document.createElement("canvas")
        canvas.width = this.glyphs.length * 8 * GLYPH_SCALE
        canvas.height = 8 * GLYPH_SCALE
        const context = canvas.getContext("2d")
        this.glyphs.forEach((glyph, index) => GLYPHS[glyph].forEach((bits, row) => {
            for (let column = 0; column < 8; column++) {
                if ((bits & (0x80 >> column)) !== 0) {
                    context.fillRect((index * 8 + column) * GLYPH_SCALE, row * GLYPH_SCALE, GLYPH_SCALE, GLYPH_SCALE)
                }
            }
        }))
        return canvas.toDataURL()
    }
    write(element, text) {
        const upper = text.toUpperCase()
        if (element.dataset.text === upper) {return}
        element.dataset.text = upper
        element.replaceChildren(...Array.from(upper, char => {
            const glyph = document.createElement("span")
            glyph.className = "glyph"
            const index = this.glyphs.indexOf(char)
            const position = `${-(index === -1 ? this.glyphs.indexOf(" ") : index) * 8}px 0`
            glyph.style.maskPosition = position
            glyph.style.webkitMaskPosition = position
            return glyph
        }))
    }
    stack(...children) {
        const stack = document.createElement("div")
        stack.className = "stack"
        stack.append(...children)
        return stack
    }
    row(...children) {
        const row = document.createElement("div")
        row.className = "row"
        row.append(...children)
        return row
    }
    digits(...entries) {
        const grid = document.createElement("div")
        grid.className = "digits"
        grid.append(...entries.map(([name, label]) => this.field(name, label, 0, 15, 0.08, value => hex(value, 1))))
        return grid
    }
    toggle(name, text) {
        const element = document.createElement("div")
        element.className = "toggle"
        element.append(this.pixel(text))
        const param = this.host.params[name]
        const update = () => element.classList.toggle("on", param.value >= 0.5)
        element.addEventListener("click", () => this.host.edit(() => param.set(param.value >= 0.5 ? 0 : 1)))
        param.subscribe(update)
        this.host.attachParameter(element, name)
        update()
        return element
    }
    modelToggle() {
        const element = this.toggle("mos8580", "")
        const param = this.host.params.mos8580
        const label = element.firstChild
        const update = () => this.write(label, param.value >= 0.5 ? "8580" : "6581")
        param.subscribe(update)
        update()
        return element
    }
    field(name, label, min, max, perPixel, format, integer = true) {
        const element = document.createElement("div")
        element.className = "field"
        const value = document.createElement("span")
        value.className = "value"
        const digits = this.pixel("")
        value.append(digits)
        element.append(this.pixel(label), value)
        const param = this.host.params[name]
        const update = () => this.write(digits, format(param.value))
        element.addEventListener("pointerdown", event => {
            if (event.button !== 0) {return}
            element.setPointerCapture(event.pointerId)
            const gesture = this.host.gesture()
            const startY = event.clientY, startValue = param.value
            const move = moveEvent => {
                const delta = (startY - moveEvent.clientY) * perPixel * (moveEvent.shiftKey ? 0.1 : 1)
                const next = Math.max(min, Math.min(max, startValue + delta))
                gesture.edit(() => param.set(integer ? Math.round(next) : next))
            }
            const end = () => {
                gesture.end()
                element.removeEventListener("pointermove", move)
                element.removeEventListener("pointerup", end)
                element.removeEventListener("pointercancel", end)
            }
            element.addEventListener("pointermove", move)
            element.addEventListener("pointerup", end)
            element.addEventListener("pointercancel", end)
        })
        param.subscribe(update)
        this.host.attachParameter(element, name, {enterValue: true})
        update()
        return element
    }
    drawScope() {
        const {context, width, height} = prepare(this.scope)
        const values = this.scopeValues
        const span = values.length >> 1
        let start = 1
        while (start < span && !(values[start - 1] < 0 && values[start] >= 0)) {start++}
        if (start === span) {start = 0}
        let peak = 0.25
        for (let index = 0; index < values.length; index++) {peak = Math.max(peak, Math.abs(values[index]))}
        context.strokeStyle = DIM
        context.beginPath()
        context.moveTo(0, height / 2)
        context.lineTo(width, height / 2)
        context.stroke()
        context.strokeStyle = LIGHT_BLUE
        context.beginPath()
        for (let index = 0; index < span; index++) {
            const x = index / (span - 1) * width
            const y = height / 2 - values[start + index] / peak * (height / 2 - 2)
            if (index === 0) {context.moveTo(x, y)} else {context.lineTo(x, y)}
        }
        context.stroke()
    }
    drawCurve() {
        const {context, width, height} = prepare(this.curve)
        const {attack, decay, sustain, release} = this.host.params
        const level = sustain.value / 15
        const segments = [Math.sqrt(ATTACK_MS[attack.value]), Math.sqrt(3 * ATTACK_MS[decay.value]), 20,
            Math.sqrt(3 * ATTACK_MS[release.value])]
        const scale = width / segments.reduce((sum, segment) => sum + segment, 0)
        const [x1, x2, x3] = [segments[0] * scale, (segments[0] + segments[1]) * scale, (segments[0] + segments[1] + segments[2]) * scale]
        const x4 = x3 + segments[3] * scale
        const top = 3, bottom = height
        const y = value => bottom - value * (bottom - top)
        const path = new Path2D()
        path.moveTo(0, bottom)
        path.lineTo(x1, top)
        const fall = step => (Math.exp(-5 * step / 16) - Math.exp(-5)) / (1 - Math.exp(-5))
        for (let step = 1; step <= 16; step++) {path.lineTo(x1 + (x2 - x1) * step / 16, y(level + (1 - level) * fall(step)))}
        path.lineTo(x3, y(level))
        for (let step = 1; step <= 16; step++) {path.lineTo(x3 + (x4 - x3) * step / 16, y(level * fall(step)))}
        context.globalAlpha = 0.3
        context.fill(path)
        context.globalAlpha = 1
        context.stroke(path)
    }
    drawResponse() {
        const {context, width, height} = prepare(this.response)
        const {filter, lowpass, bandpass, highpass, cutoff, resonance, mos8580} = this.host.params
        const model = mos8580.value >= 0.5
        const center = cutoffHz(model, cutoff.value)
        const damping = filterDamping(model, resonance.value)
        const decibels = frequency => {
            if (filter.value < 0.5) {return 0}
            const ratio = frequency / center
            const realDen = 1 - ratio * ratio, imagDen = damping * ratio
            const realNum = -(lowpass.value >= 0.5 ? 1 : 0) + (highpass.value >= 0.5 ? ratio * ratio : 0)
            const imagNum = bandpass.value >= 0.5 ? ratio : 0
            const magnitude = Math.hypot(realNum, imagNum) / Math.hypot(realDen, imagDen)
            return 20 * Math.log10(Math.max(magnitude, 1e-4))
        }
        const y = value => (18 - Math.max(-30, Math.min(18, value))) / 48 * height
        context.strokeStyle = DIM
        context.beginPath()
        for (const frequency of [100, 1000, 10000]) {
            const x = Math.log(frequency / 20) / Math.log(1000) * width
            context.moveTo(x, 0)
            context.lineTo(x, height)
        }
        context.moveTo(0, y(0))
        context.lineTo(width, y(0))
        context.stroke()
        context.strokeStyle = LIGHT_BLUE
        context.globalAlpha = filter.value >= 0.5 ? 1 : 0.5
        context.beginPath()
        for (let x = 0; x <= width; x++) {
            const value = y(decibels(20 * Math.pow(1000, x / width)))
            if (x === 0) {context.moveTo(x, value)} else {context.lineTo(x, value)}
        }
        context.stroke()
    }
}
