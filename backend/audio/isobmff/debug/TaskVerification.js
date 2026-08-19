const SampleBuilder = require('../SampleBuilder');

function verifyDrift() {
    console.log("=== CLOCK DIVERGENCE PROOF ===");

    const timescale = 48000;
    const msPerTick = 1000 / timescale;

    // Simulate a typical MKV sequence where muxer rounds 21.333 to 21 or 22
    // Let's assume the muxer uses a constant 22ms for some reason (e.g. bad transcode)
    const packets = [];
    for (let i = 0; i < 5; i++) {
        packets.push({
            time: i * 22.0,
            duration: 22.0,
            payload: Buffer.alloc(500)
        });
    }

    let sourceBaseTime = packets[0].time;
    let serializerBaseTime = Math.round(sourceBaseTime * (timescale / 1000)) * msPerTick;
    let currentSerializerTicks = BigInt(Math.round(sourceBaseTime * (timescale / 1000)));

    console.log(`Initial: MKV=${sourceBaseTime}ms, SRZ=${serializerBaseTime}ms`);

    packets.forEach((packet, i) => {
        const sample = SampleBuilder.buildSample(packet, timescale);

        const mkvElapsed = packet.time - sourceBaseTime;
        const serializerElapsed = (Number(currentSerializerTicks) * msPerTick) - serializerBaseTime;
        const diff = serializerElapsed - mkvElapsed;

        console.log(`Pkt #${i} | MKV Elapsed: ${mkvElapsed.toFixed(3)}ms | SRZ Elapsed: ${serializerElapsed.toFixed(3)}ms | Diff: ${diff.toFixed(3)}ms`);

        // The "FIRST instruction" that causes divergence:
        currentSerializerTicks += BigInt(sample.duration);
    });

    console.log("\nCONCLUSION:");
    console.log("If Diff becomes increasingly negative, it proves the Serializer clock is slower than the Source clock.");
}

verifyDrift();
