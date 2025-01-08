import { sleep, FTYPES, padZeroStart } from "./utils/utils.js"

export class Manager {
    constructor() {
        this.drcDecoderInit = false;
        this.videoExtracterInit = false;
        this.jsonDecoder = new TextDecoder();
        this.totalGroups = 0;
        this.GOP = 30;
        this.duration = 300;
        this.fps = 30;
        this.highxyzBuffer = {};
        this.lowxyzBuffer = {};
        this.rotBuffer = {};
        this.cbBuffer = {};
        // track how many **groups** are ready
        // help to indicate the progress
        // minus 1 for init ply
        this.plyLoaded = -1;
        this.highxyzLoaded = 0;
        this.lowxyzLoaded = 0;
        this.rotLoaded = 0;
        this.cbLoaded = 0;
        // whether can play
        this.initCb = null;
        this.canPlay = false;
        // current frame
        this.currentFrame = 0;

    }

    // update the prompt in the middle
    updatePrompt(hint) {
        document.getElementById("message").innerText = hint;
        var oldone = document.getElementById("message").innerText;
        if (oldone.startsWith(hint) && oldone.length == 10) {
            oldone = oldone + ".";
        } else {
            oldone = hint;
        }
        document.getElementById("message").innerText = oldone;
    }

    async blockUntilAllReady() {
        while (!this.drcDecoderInit) {
            await sleep(300);
            this.updatePrompt('loading wasm');
        }
        document.getElementById("message").innerText = 'DRC decoder ready';
        while (!this.videoExtracterInit) {
            await sleep(300);
            this.updatePrompt('loading opencv');
        }
        document.getElementById("message").innerText = 'video extracter ready';
    }

    // retrieve the data according to currentFrame
    getFromCurrentFrame(type) {
        var currentGroup = padZeroStart(Math.floor(this.currentFrame / this.GOP) * this.GOP);
        switch (type) {
            case FTYPES.cb:
                return this.cbBuffer[currentGroup];
            case FTYPES.highxyz:
                return this.highxyzBuffer[currentGroup][this.currentFrame % this.GOP];
            case FTYPES.lowxyz:
                return this.lowxyzBuffer[currentGroup][this.currentFrame % this.GOP];
            case FTYPES.rot:
                return this.rotBuffer[currentGroup][this.currentFrame % this.GOP];
            default:
                break;
        }
    }


    async blockUntilCanplay() {
        if (this.initPly == null && this.initCb == null) {
            document.getElementById("message").innerText = 'loading initial data';
        }
        while (!this.canPlay) {
            document.getElementById("message").innerText = 'loading data';
            await sleep(300);
            const minloaded = Math.min(this.plyLoaded, this.highxyzLoaded, this.lowxyzLoaded, this.rotLoaded, this.cbLoaded);
            // TODO 检查提前量
            if (this.initCb != null && minloaded >= Math.floor(this.currentFrame / this.GOP) + 10) {
                this.canPlay = true;
            }
        }
        document.getElementById("message").innerText = '';
    }

    appendOneBuffer(buffer, key, type) {
        if (type === FTYPES.ply) {
            // this.plyBuffer[key] = buffer;
            this.plyLoaded += 1;
            this.updateProgressHint(FTYPES.ply);
        } else if (type === FTYPES.highxyz) {
            if (this.highxyzBuffer[key] == undefined) {
                this.highxyzBuffer[key] = [];
                this.highxyzBuffer[key].push(new Uint8Array(buffer));
            } else {
                this.highxyzBuffer[key].push(new Uint8Array(buffer));
            }
        } else if (type === FTYPES.lowxyz) {
            if (this.lowxyzBuffer[key] == undefined) {
                this.lowxyzBuffer[key] = [];
                this.lowxyzBuffer[key].push(new Uint8Array(buffer));
            } else {
                this.lowxyzBuffer[key].push(new Uint8Array(buffer));
            }
        } else if (type === FTYPES.rot) {
            if (this.rotBuffer[key] == undefined) {
                this.rotBuffer[key] = [];
                this.rotBuffer[key].push(new Uint8Array(buffer));
            } else {
                this.rotBuffer[key].push(new Uint8Array(buffer));
            }
        } else if (type === FTYPES.cb) {
            const jsonData = JSON.parse(this.jsonDecoder.decode(buffer));
            this.cbBuffer[key] = jsonData;
            this.cbLoaded += 1;
            this.updateProgressHint(FTYPES.cb);
        }
    }

    incrementVideoLoaded(type) {
        if (type === FTYPES.highxyz) {
            this.highxyzLoaded += 1;
        } else if (type === FTYPES.lowxyz) {
            this.lowxyzLoaded += 1;
        } else if (type === FTYPES.rot) {
            this.rotLoaded += 1;
        }
        this.updateProgressHint(type);
    }

    // set init codebook
    setInitCb(data) {
        this.initCb = JSON.parse(this.jsonDecoder.decode(data));
    }

    initDrcDecoder() {
        this.drcDecoderInit = true;
    }

    initExtracter() {
        this.videoExtracterInit = true;
    }

    setMetaInfo(totalGroups, GOP, duration, target_fps) {
        this.totalGroups = totalGroups;
        this.GOP = GOP;
        this.duration = duration;
        this.fps = target_fps;
        this.updateProgressHint(FTYPES.ply);
        this.updateProgressHint(FTYPES.highxyz);
        this.updateProgressHint(FTYPES.lowxyz);
        this.updateProgressHint(FTYPES.rot);
        this.updateProgressHint(FTYPES.cb);
    }

    // update the progress hint in the top-left corner
    updateProgressHint(type) {
        if (type === FTYPES.ply) {
            document.getElementById("plyProgress").innerText = 'ply: ' + (this.plyLoaded * this.GOP / this.fps).toFixed(2)
                + '/' + Math.floor(this.duration / this.fps);
        } else if (type === FTYPES.highxyz) {
            document.getElementById("highProgress").innerText = 'high: ' + (this.highxyzLoaded * this.GOP / this.fps).toFixed(2)
                + '/' + Math.floor(this.duration / this.fps);;
        } else if (type === FTYPES.lowxyz) {
            document.getElementById("lowProgress").innerText = 'low: ' + (this.lowxyzLoaded * this.GOP / this.fps).toFixed(2)
                + '/' + Math.floor(this.duration / this.fps);;
        } else if (type === FTYPES.rot) {
            document.getElementById("rotProgress").innerText = 'rot: ' + (this.rotLoaded * this.GOP / this.fps).toFixed(2)
                + '/' + Math.floor(this.duration / this.fps);
        } else if (type === FTYPES.cb) {
            document.getElementById("cbProgress").innerText = 'codebooks: ' + (this.cbLoaded * this.GOP / this.fps).toFixed(2)
                + '/' + Math.floor(this.duration / this.fps);;
        }
    }

    getNextIndex(type) {
        let idx = -1;
        switch (type) {
            case FTYPES.ply:
                idx = this.plyLoaded;
                break;
            case FTYPES.highxyz:
                idx = this.highxyzLoaded;
                break;
            case FTYPES.lowxyz:
                idx = this.lowxyzLoaded;
                break;
            case FTYPES.rot:
                idx = this.rotLoaded;
                break;
            case FTYPES.cb:
                idx = this.cbLoaded;
                break;
        }
        if (idx >= this.totalGroups) {
            return -1;
        }
        return idx;
    }

    reload() {
        this.drcDecoderInit = false;
        this.videoExtracterInit = false;
        this.highxyzBuffer = {};
        this.lowxyzBuffer = {};
        this.rotBuffer = {};
        this.plyLoaded = 0;
        this.highxyzLoaded = 0;
        this.lowxyzLoaded = 0;
        this.rotLoaded = 0;
    }

}