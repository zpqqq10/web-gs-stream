import { FTYPES } from "../utils/utils.js";
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs";
// import { loadPyodide } from "../utils/pyodide/pyodide.mjs";
let videoDownloader = null;

// use pyodide here
// since webCodec and <video> will smooth and change the pixel value
class VideoExtracter {
    constructor() {
        this.initialized = false;
        this.pyodide = undefined;
        // function for extracting frames from video
        this.extractFrames = undefined;
        // reorganizing the rotation frame is quite fast here
        // or it can be placed in shader
        this.pythonScript = `
        import os
        import cv2
        import numpy as np
        from js import console
      
        def extract_frames_from_buffer(videoPath: str, isGrey: bool):
            # Decode video
            video = cv2.VideoCapture(videoPath)
            if not video.isOpened():
                console.error("Failed to open video")
                return np.array([])
            frames = []
            while True:
                ret, frame = video.read()
                if not ret:
                    break
                if isGrey:
                    reso = frame.shape[1]
                    frames.append(frame[..., 0].reshape((4, reso, reso)).transpose(1, 2, 0).flatten())
                    # if to combine the quaternion in shader
                    # frames.append(frame[..., :1].flatten())
                else:
                    frames.append(frame.flatten())
            video.release()
            os.remove(videoPath)
            return np.array(frames)
        `;
        this.init();
    }

    async init() {
        this.pyodide = await loadPyodide();
        await this.pyodide.loadPackage('opencv-python');
        await this.pyodide.loadPackage('numpy');
        await this.pyodide.runPythonAsync(this.pythonScript);
        this.extractFrames = await this.pyodide.globals.get('extract_frames_from_buffer');
        this.initialized = true;
        postMessage({ msg: 'ready' });
    }

    async extract(dataBuffer, keyframe, type) {
        if (!this.initialized) {
            throw new Error('video downloader not initialized');
        }

        let videoName = '';
        switch (type) {
            case FTYPES.lowxyz:
                videoName = `/tmp/lowxyz${keyframe}.mp4`;
                break;
            case FTYPES.highxyz:
                videoName = `/tmp/highxyz${keyframe}.mp4`;
                break;
            case FTYPES.rot:
                videoName = `/tmp/rot${keyframe}.mp4`;
                break;
            default:
                throw new Error('unknown type');
        }

        await this.saveVideoToPyodideFS(dataBuffer, videoName);
        const npres = this.extractFrames(videoName, type == FTYPES.rot);
        const frames = npres.toJs();
        // use transfer to speed up
        const transferableObject = {
            buffers: frames.map((buffer, index) => ({ id: index, buffer })),
        }
        const framesBuffer = frames.map((frame) => frame.buffer);
        postMessage({ data: transferableObject, keyframe: keyframe, type: type }, framesBuffer);

    }

    async saveVideoToPyodideFS(dataBuffer, fileName) {
        const data = new Uint8Array(dataBuffer);
        await this.pyodide.FS.writeFile(fileName, data);
        // console.log(`Video saved to Pyodide FS as ${fileName}`);
    }

    finish() {
        // do nothing
        console.log('extracter current time', new Date().toLocaleTimeString());
    }
}

onmessage = (e) => {
    if (e.data.data) {
        videoDownloader.extract(e.data.data, e.data.keyframe, e.data.type);
    } else if (e.data.msg && e.data.msg === 'init') {
        videoDownloader = new VideoExtracter();
    } else if (e.data.msg && e.data.msg === 'finish') {
        videoDownloader.finish();
    }
};

// value is smoothed
// // determine which to use
// let videoEleName = '';
// let canvasEleName = '';
// switch (type) {
//   case FTYPES.lowxyz:
//     videoEleName = 'lowxyzVideo';
//     canvasEleName = 'lowxyzCanvas';
//     break;
//   case FTYPES.highxyz:
//     videoEleName = 'highxyzVideo';
//     canvasEleName = 'highxyzCanvas';
//     break;
//   case FTYPES.rot:
//     videoEleName = 'rotVideo';
//     canvasEleName = 'rotCanvas';
//     break;
//   default:
//     throw new Error('unknown type');
// }

// const videoEle = document.getElementById(videoEleName);
// const canvasEle = document.getElementById(canvasEleName);
// const captureCtx = canvasEle.getContext('2d', { willReadFrequently: true });
// captureCtx.imageSmoothingEnabled = false;

// const blob = new Blob([data], { type: 'video/mp4' });
// const videoUrl = URL.createObjectURL(blob);
// videoEle.src = videoUrl;
// let cmp = []

// await startFrameCapture();
// if (keyframe == keyframes[0]) {
//   console.log(cmp)
// }
// async function startFrameCapture() {
//   try {
//     await new Promise((resolve, reject) => {
//       videoEle.oncanplay = resolve;
//       videoEle.onerror = reject;
//     });

//     for (let currentTime = 0; currentTime < videoEle.duration; currentTime += gsvMeta.frameDuration) {

//       videoEle.pause()
//       videoEle.currentTime = currentTime;
//       await new Promise((resolve) => {
//         videoEle.onseeked = resolve;
//       });

//       captureCtx.drawImage(videoEle, 0, 0, canvasEle.width, canvasEle.height);

//       const imageData = captureCtx.getImageData(0, 0, canvasEle.width, canvasEle.height);
//       cmp.push(imageData.data)
//     }

//   } catch (error) {
//     console.error('Error during frame capture:', error);
//   }
// }