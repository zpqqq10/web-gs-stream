import { sleep, FTYPES, padZeroStart } from "./utils/utils.js"

export class Manager {
    constructor() {
        this.drcDecoderInit = false;
        this.videoExtracterInit = false;
        this.jsonDecoder = new TextDecoder();
        this.totalGroups = 0;
        this.GOP = 30;
        this.overlap = 5;
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
        this.cbLoaded = -1;
        // whether can play
        this.initCb = null;
        // current frame
        this.currentFrame = 0;
        this.counter = 0;
        // how many future groups are ready to allow playing
        this.bufferLen = 2;

    }

    // update the prompt in the middle
    updateMessagePrompt(hint) {
        var oldone = document.getElementById("message").innerText;
        if (oldone.startsWith(hint) && oldone.length < 24) {
            oldone = oldone + ".";
        } else {
            oldone = hint;
        }
        document.getElementById("message").innerText = oldone;
    }

    async blockUntilAllReady() {
        document.getElementById("message").innerText = 'loading wasm';
        while (!this.drcDecoderInit) {
            await sleep(300);
            this.updateMessagePrompt('loading wasm');
        }
        document.getElementById("message").innerText = 'DRC decoder ready';
        await sleep(500);
        document.getElementById("message").innerText = 'loading opencv';
        while (!this.videoExtracterInit) {
            await sleep(300);
            this.updateMessagePrompt('loading opencv');
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

    // retrieve the data according to currentFrame for overlap
    getFromOverlapFrame(type) {
        const groupIdx = Math.floor(this.currentFrame / this.GOP);
        // no overlap
        if (this.currentFrame >= groupIdx * this.GOP + this.overlap) {
            return this.getFromCurrentFrame(type);
        }
        // there is overlap
        var lastGroup = padZeroStart((groupIdx == 0 ? 0 : groupIdx - 1) * this.GOP);
        switch (type) {
            case FTYPES.cb:
                return this.cbBuffer[lastGroup];
            case FTYPES.highxyz:
                return this.highxyzBuffer[lastGroup][this.currentFrame - (groupIdx == 0 ? 0 : groupIdx - 1) * this.GOP];
            case FTYPES.lowxyz:
                return this.lowxyzBuffer[lastGroup][this.currentFrame - (groupIdx == 0 ? 0 : groupIdx - 1) * this.GOP];
            case FTYPES.rot:
                return this.rotBuffer[lastGroup][this.currentFrame - (groupIdx == 0 ? 0 : groupIdx - 1) * this.GOP];
            default:
                break;
        }
    }


    async blockUntilCanplay() {
        document.getElementById("message").innerText = 'loading initial data';
        while (true) {
            if (this.initPly == null && this.initCb == null) {
                this.updateMessagePrompt('loading initial data');
            } else {
                break;
            }
            await sleep(300);
        }
        document.getElementById("message").innerText = 'loading data';
        while (true) {
            const minloaded = Math.min(this.plyLoaded, this.highxyzLoaded, this.lowxyzLoaded, this.rotLoaded, this.cbLoaded);
            if (this.initCb != null && minloaded >= Math.floor(this.currentFrame / this.GOP) + this.bufferLen) {
                break;
            } else {
                this.updateMessagePrompt('loading data');
            }
            await sleep(300);
        }
        document.getElementById("message").innerText = '';
    }

    canPlay() {
        const minloaded = Math.min(this.plyLoaded, this.highxyzLoaded, this.lowxyzLoaded, this.rotLoaded, this.cbLoaded);
        if (this.initCb != null && (minloaded >= Math.floor(this.currentFrame / this.GOP) + this.bufferLen) || minloaded == this.totalGroups) {
            document.getElementById("message").innerText = '';
            return true;
        } else {
            var oldone = document.getElementById("message").innerText;
            if (this.counter == 0) {
                oldone = (oldone.startsWith('loading data') && oldone.length < 24) ? oldone + "." : 'loading data';
            }
            this.counter = (this.counter + 1) % 30;
            document.getElementById("message").innerText = oldone;
            return false;
        }
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
            if (buffer == null) {
                // sh texture is set and then increment by 1
                this.cbLoaded += 1;
                this.updateProgressHint(FTYPES.cb);
            } else {
                const jsonData = JSON.parse(this.jsonDecoder.decode(buffer));
                this.cbBuffer[key] = jsonData;
            }
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

    setMetaInfo(totalGroups, GOP, overlap, duration, target_fps) {
        this.totalGroups = totalGroups;
        this.GOP = GOP;
        this.overlap = overlap;
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
        // if (type === FTYPES.ply) {
        //     document.getElementById("plyProgress").innerText = 'ply: ' + ((this.plyLoaded < 0 ? 0 : this.plyLoaded) * this.GOP / this.fps).toFixed(2)
        //         + '/' + Math.floor(this.duration / this.fps);
        // } else if (type === FTYPES.highxyz) {
        //     document.getElementById("highProgress").innerText = 'high: ' + (this.highxyzLoaded * this.GOP / this.fps).toFixed(2)
        //         + '/' + Math.floor(this.duration / this.fps);;
        // } else if (type === FTYPES.lowxyz) {
        //     document.getElementById("lowProgress").innerText = 'low: ' + (this.lowxyzLoaded * this.GOP / this.fps).toFixed(2)
        //         + '/' + Math.floor(this.duration / this.fps);;
        // } else if (type === FTYPES.rot) {
        //     document.getElementById("rotProgress").innerText = 'rot: ' + (this.rotLoaded * this.GOP / this.fps).toFixed(2)
        //         + '/' + Math.floor(this.duration / this.fps);
        // } else if (type === FTYPES.cb) {
        //     document.getElementById("cbProgress").innerText = 'codebooks: ' + ((this.cbLoaded < 0 ? 0 : this.cbLoaded) * this.GOP / this.fps).toFixed(2)
        //         + '/' + Math.floor(this.duration / this.fps);;
        // }
        // update buffered bar
        const minloaded = Math.min(this.plyLoaded, this.highxyzLoaded, this.lowxyzLoaded, this.rotLoaded, this.cbLoaded);
        const bufferedBar = document.getElementById('buffered-bar');
        bufferedBar.style.width = (minloaded / this.totalGroups * 100) + '%';
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