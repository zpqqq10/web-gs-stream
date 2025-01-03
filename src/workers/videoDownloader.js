import { FTYPES } from "../utils/utils.js";
let videoDownloader = null;

class VideoDownloader {
    constructor() {
        this.initialized = true;
        postMessage({ msg: 'ready' });
    }

    async download(baseUrl, keyframe, type) {
        if (!this.initialized) {
            throw new Error('video downloader not initialized');
        }

        let videoName = '';
        switch (type) {
            case FTYPES.lowxyz:
                videoName = '/lowxyz.mp4';
                break;
            case FTYPES.highxyz:
                videoName = '/highxyz.mp4';
                break;
            case FTYPES.rot:
                videoName = '/quat.mp4';
                break;
            default:
                throw new Error('unknown type');
        }
        // download for one frame
        // console.time('download video of ' + keyframe)
        const req = await fetch(new URL(keyframe + videoName, baseUrl));
        if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);
        const dataBuffer = await req.arrayBuffer();
        postMessage({ data: dataBuffer, keyframe: keyframe, type: type }, [dataBuffer]);
        // console.timeEnd('download video of ' + keyframe)

    }

    finish() {
        // do nothing
        console.log('downloader current time', new Date().toLocaleTimeString());
    }
}

onmessage = (e) => {
    if (e.data.baseUrl) {
        videoDownloader.download(e.data.baseUrl, e.data.keyframe, e.data.type);
    } else if (e.data.msg && e.data.msg === 'init') {
        videoDownloader = new VideoDownloader();
    } else if (e.data.msg && e.data.msg === 'finish') {
        videoDownloader.finish();
    }
};
