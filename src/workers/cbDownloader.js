import { FTYPES } from "../utils/utils.js";
let cbDownloader = null;

// download codebooks
class CBDownloader {
    constructor() {
        this.initialized = true;
        // postMessage({ msg: 'ready' });
    }

    async reload(baseUrl, keyframe) {
        if (!this.initialized) {
            throw new Error('video downloader not initialized');
        }
        if (keyframe == -1){
            // process the init codebook
            const req = await fetch(new URL('init_codebooks.json', baseUrl));
            if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);
            // pass arraybuffer rather than json, to avoid copying                                                      
            const codebooks = await req.arrayBuffer();
            postMessage({ data: codebooks, keyframe: keyframe, type: FTYPES.cb }, [codebooks]);
        } else {
            const req = await fetch(new URL(keyframe + '/codebooks.json', baseUrl));
            if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);
            // pass arraybuffer rather than json, to avoid copying                                                      
            const codebooks = await req.arrayBuffer();
            // TODO 这里要查一下 很可能会有性能问题
            postMessage({ data: codebooks, keyframe: keyframe, type: FTYPES.cb }, [codebooks]);
        }
    }

    finish() {
        // do nothing
    }
}

onmessage = (e) => {
    if (e.data.baseUrl) {
        cbDownloader.reload(e.data.baseUrl, e.data.keyframe);
    } else if (e.data.msg && e.data.msg === 'init') {
        cbDownloader = new CBDownloader();
    } else if (e.data.msg && e.data.msg === 'finish') {
        cbDownloader.finish();
    }
};