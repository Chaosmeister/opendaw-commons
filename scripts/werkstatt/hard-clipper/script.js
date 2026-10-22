// @label Hard Clipper
// @param threshold 0.5 0.1 1.0 linear
// @param soft false
// @param mix 1 0 1 linear

class Processor {
    threshold = 0.5
    soft = 0
    mix = 1
    paramChanged(label, value) {
        if (label === "threshold") this.threshold = value
        if (label === "soft") this.soft = value
        if (label === "mix") this.mix = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const t = this.threshold
        if (this.soft) {
            for (let i = s0; i < s1; i++) {
                outL[i] = srcL[i] + (Math.tanh(srcL[i] / t) * t - srcL[i]) * this.mix
                outR[i] = srcR[i] + (Math.tanh(srcR[i] / t) * t - srcR[i]) * this.mix
            }
        } else {
            for (let i = s0; i < s1; i++) {
                outL[i] = srcL[i] + (Math.max(-t, Math.min(t, srcL[i])) - srcL[i]) * this.mix
                outR[i] = srcR[i] + (Math.max(-t, Math.min(t, srcR[i])) - srcR[i]) * this.mix
            }
        }
    }
}