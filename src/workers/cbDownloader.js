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
        const req = await fetch(new URL(keyframe + '/codebooks.json', baseUrl));
        if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);
        const codebooks = await req.json();
        // TODO 这里要查一下 很可能会有性能问题
        postMessage({ data: codebooks, keyframe: keyframe, type: FTYPES.cb });
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
    }
};