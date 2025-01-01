import { FTYPES } from "../utils/utils.js";
import { drc2plyModule } from "../wasm/drc2ply.js";
// adjust path in drc2ply.js:findWasmBinary()

let plyworker = null;

class PlyWorker {
    constructor() {
        this.initialized = false;
        this.drcDecoder = undefined;
        this.drc2plyFc = undefined;
        // not waiting here
        this.init();
    }

    async init() {
        this.initialized = true;
        this.drcDecoder = await new drc2plyModule();
        this.drc2plyFc = this.drcDecoder.cwrap('drc2ply', 'number', ['number', 'number', 'number']);
        this.inputPtr = this.drcDecoder._malloc(4)
        this.outputPtr = this.drcDecoder._malloc(3 * 1024 * 1024);
        postMessage({ msg: 'ready' });
    }

    async load(baseUrl, keyframe) {
        if (!this.initialized) {
            throw new Error('ply workder not initialized');
        }

        // continue downloading
        console.time('download drc&gz of ' + keyframe)
        let drcReq = await fetch(new URL(keyframe + '/update_pc.drc', baseUrl))
        if (drcReq.status != 200) throw new Error(drcReq.status + " Unable to load " + drcReq.url);
        let drc = await drcReq.arrayBuffer();
        drc = new Uint8Array(drc);
        this.drcDecoder.HEAPU8.set(drc, this.inputPtr);
        // size of the resulting ply
        const plySize = this.drc2plyFc(this.inputPtr, drc.length, this.outputPtr);
        const outputArrayBuffer = this.drcDecoder.HEAPU8.slice(this.outputPtr, this.outputPtr + plySize);
        postMessage({ data: outputArrayBuffer, keyframe: keyframe, type: FTYPES.ply }, [outputArrayBuffer.buffer]);

        console.timeEnd('download drc&gz of ' + keyframe);
    }

    // called after all tasks are done
    finish() {
        console.log('ply current time', new Date().toLocaleTimeString());
        // this.drcDecoder._free(this.inputPtr);
        // this.drcDecoder._free(this.outputPtr);

    }
}

onmessage = (e) => {
    if (e.data.baseUrl) {
        plyworker.load(e.data.baseUrl, e.data.keyframe);
    } else if (e.data.msg && e.data.msg === 'init') {
        plyworker = new PlyWorker();
    } else if (e.data.msg && e.data.msg === 'finish') {
        plyworker.finish();
    }
};