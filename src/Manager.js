import { sleep, FTYPES } from "./utils/utils.js"

export class Manager {
    constructor() {
        this.drcDecoderInit = false;
        this.jsonDecoder = new TextDecoder();
        this.totalGroups = 0;
        this.plyBuffer = {};
        this.highxyzBuffer = {};
        this.lowxyzBuffer = {};
        this.rotBuffer = {};
        this.cbBuffer = {};
        // track how many **groups** are ready
        // help to indicate the progress
        this.plyLoaded = 0;
        this.highxyzLoaded = 0;
        this.lowxyzLoaded = 0;
        this.rotLoaded = 0;
        this.cbLoaded = 0;
        // whether can play
        this.initPly = null;
        this.initCb = null;
        this.canPlay = false;
        // current frame
        this.currentFrame = 0;

    }

    updatePrompt() {
        document.getElementById("message").innerText = 'loading wasm';
        var oldone = document.getElementById("message").innerText;
        if (oldone.startsWith('loading wasm') && oldone.length == 10) {
            oldone = oldone + ".";
        } else {
            oldone = 'loading wasm';
        }
        document.getElementById("message").innerText = oldone;
    }

    async blockUntilAllReady() {
        while (!this.drcDecoderInit) {
            await sleep(300);
            this.updatePrompt();
        }
        document.getElementById("message").innerText = 'DRC decoder ready';
    }

    async blockUntilCanplay() {
        if (this.initPly == null && this.initCb == null) {
            document.getElementById("message").innerText = 'loading initial data';
        } else {
            document.getElementById("message").innerText = 'loading data';
        }
        while (!this.canPlay) {
            await sleep(300);
            const minloaded = Math.min(this.plyLoaded, this.highxyzLoaded, this.lowxyzLoaded, this.rotLoaded, this.cbLoaded);
            // TODO 检查提前量
            if (this.initPly != null && this.initCb != null && minloaded >= this.currentFrame + 1) {
                this.canPlay = true;
            }
        }
        document.getElementById("message").innerText = '';
    }

    appendOneBuffer(buffer, key, type) {
        if (type === FTYPES.ply) {
            this.plyBuffer[key] = buffer;
            this.plyLoaded += 1;
        } else if (type === FTYPES.highxyz) {
            if (this.highxyzBuffer[key] == undefined) {
                this.highxyzBuffer[key] = [];
                this.highxyzBuffer[key].push(buffer);
            } else {
                this.highxyzBuffer[key].push(buffer);
            }
        } else if (type === FTYPES.lowxyz) {
            if (this.lowxyzBuffer[key] == undefined) {
                this.lowxyzBuffer[key] = [];
                this.lowxyzBuffer[key].push(buffer);
            } else {
                this.lowxyzBuffer[key].push(buffer);
            }
        } else if (type === FTYPES.rot) {
            if (this.rotBuffer[key] == undefined) {
                this.rotBuffer[key] = [];
                this.rotBuffer[key].push(buffer);
            } else {
                this.rotBuffer[key].push(buffer);
            }
        } else if (type === FTYPES.cb) {
            const jsonData = JSON.parse(this.jsonDecoder.decode(buffer));
            if (this.cbBuffer[key] == undefined) {
                this.cbBuffer[key] = jsonData;
                this.cbLoaded += 1;
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
    }

    // set init ply
    setInitPly(data) {
        this.initPly = data;
    }

    // set init codebook
    setInitCb(data) {
        this.initCb = JSON.parse(this.jsonDecoder.decode(data));
    }

    initDrcDecoder() {
        this.drcDecoderInit = true;
    }

    setTotalGroups(totalGroups) {
        this.totalGroups = totalGroups;
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
        this.videoDecoderInit = false;
        this.plyBuffer = {};
        this.highxyzBuffer = {};
        this.lowxyzBuffer = {};
        this.rotBuffer = {};
        this.plyLoaded = 0;
        this.highxyzLoaded = 0;
        this.lowxyzLoaded = 0;
        this.rotLoaded = 0;
    }

}