const MP4Generator = require('../MP4Generator');
const SampleBuilder = require('../SampleBuilder');
const TimestampConverter = require('../TimestampConverter');
const FragmentValidator = require('./FragmentValidator');

/**
 * SelfTest - Proves the ISOBMFF pipeline logic in isolation.
 */
function runTest() {
    const track = {
        number: 1,
        codecId: 'A_AAC',
        sampleRate: 48000,
        channels: 2,
        codecPrivate: Buffer.from([0x11, 0x90]), // AAC LC 48kHz Stereo
        bitrate: 128000
    };

    console.log("--- STARTING ISOBMFF SELF TEST ---");

    // 1. Init Segment
    const init = MP4Generator.generateInitSegment(track);
    FragmentValidator.validate(init, "Initialization Segment");

    // 2. Fragment 1
    const packets1 = [
        { payload: Buffer.alloc(500, 1), time: 0, duration: 21 },
        { payload: Buffer.alloc(500, 2), time: 21, duration: 21 },
        { payload: Buffer.alloc(500, 3), time: 42, duration: 21 }
    ];

    const timescale = track.sampleRate;
    const baseTime1 = BigInt(TimestampConverter.calculateBaseMediaDecodeTime(0, timescale));
    const samples1 = SampleBuilder.buildSamples(packets1, timescale);
    const frag1 = MP4Generator.generateFragment(1, samples1, baseTime1);

    FragmentValidator.validate(frag1, "Fragment #1");

    // 3. Fragment 2 (Continuity check)
    // First fragment duration: 21+21+21 = 63ms
    const baseTime2Ms = 63;
    const packets2 = [
        { payload: Buffer.alloc(600, 4), time: 63, duration: 21 },
        { payload: Buffer.alloc(600, 5), time: 84, duration: 21 }
    ];

    const baseTime2 = TimestampConverter.calculateBaseMediaDecodeTime(baseTime2Ms, timescale);
    const samples2 = SampleBuilder.buildSamples(packets2, timescale);
    const frag2 = MP4Generator.generateFragment(2, samples2, baseTime2);

    FragmentValidator.validate(frag2, "Fragment #2");

    console.log("Expected Continuity: baseTime2 should be baseTime1 + sum(samples1.duration)");
    const totalDur1 = samples1.reduce((s, d) => s + d.duration, 0);
    console.log(`Fragment 1 End: ${baseTime1 + totalDur1}`);
    console.log(`Fragment 2 Start: ${baseTime2}`);

    if (Number(baseTime2) === (baseTime1 + totalDur1)) {
        console.log(">> CONTINUITY VERIFIED ✅");
    } else {
        console.log(">> CONTINUITY ERROR ❌");
    }
}

try {
    runTest();
} catch (err) {
    console.error("Test Crashed:", err);
}
