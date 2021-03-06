"use strict";
/**
 * 与服务器进行通信并返回结果
 *
 * @class Options
 */
class Options {
    constructor() {
        /**
         * 回调函数
         *
         * @private
         * @memberof Options
         */
        this.__callback = {};
        /**
         * 加密相关
         *
         * @private
         * @type {boolean}
         * @memberof Options
         */
        this.__crypto = false;
        // 关闭窗口时断开连接
        window.onunload = () => { options.close(); };
    }
    /**
     * 随机16进制数
     *
     * @readonly
     * @protected
     * @type {string}
     * @memberof Options
     */
    get _ts() {
        const bufArray = window.crypto.getRandomValues(new Uint32Array(5));
        let random = '';
        bufArray.forEach(value => { random += value.toString(16); });
        return random.slice(0, 32);
    }
    /**
     * hex字符串转为Uint8Array
     *
     * @param {string} hex
     * @returns {Uint8Array}
     * @memberof Options
     */
    hex2buf(hex) {
        // @ts-ignore 需要格式正确
        return new Uint8Array(hex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    }
    /**
     * ArrayBuffer转为hex字符串
     *
     * @param {ArrayBuffer} buf
     * @returns {string}
     * @memberof Options
     */
    buf2hex(buf) {
        return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    /**
     * 连接到服务器
     *
     * @param {string} path
     * @param {string[]} protocols
     * @returns {Promise<boolean>}
     * @memberof Options
     */
    connect(path, protocols) {
        return new Promise(resolve => {
            try {
                const ws = new WebSocket(path, protocols);
                const removeEvent = () => {
                    this.__crypto = false;
                    delete ws.onopen;
                    delete ws.onerror;
                };
                ws.onopen = async () => {
                    removeEvent();
                    this._ws = ws;
                    this._init();
                    if (window.crypto.subtle !== undefined) {
                        const clientKey = await window.crypto.subtle.generateKey({
                            name: 'ECDH',
                            namedCurve: 'P-521'
                        }, false, ['deriveKey', 'deriveBits']);
                        const clientPublicKeyExported = await window.crypto.subtle.exportKey('raw', clientKey.publicKey);
                        const clientPublicKeyHex = this.buf2hex(clientPublicKeyExported);
                        const type = 'ECDH-AES-256-GCM';
                        const server = await this._send({ cmd: 'hello', msg: type, data: clientPublicKeyHex });
                        if (server.msg === type) {
                            const serverPublicKeyHex = server.data;
                            const serverPublicKey = this.hex2buf(serverPublicKeyHex);
                            const serverKeyImported = await window.crypto.subtle.importKey('raw', serverPublicKey, {
                                name: 'ECDH',
                                namedCurve: 'P-521'
                            }, false, []);
                            const sharedSecret = await window.crypto.subtle.deriveKey({
                                name: 'ECDH',
                                public: serverKeyImported
                            }, clientKey.privateKey, {
                                name: 'AES-GCM',
                                length: 256
                            }, false, ['encrypt', 'decrypt']);
                            this.__crypto = true;
                            this.__sharedSecret = sharedSecret;
                        }
                    }
                    resolve(true);
                };
                ws.onerror = error => {
                    removeEvent();
                    console.error(error);
                    resolve(false);
                };
            }
            catch (error) {
                console.error(error);
                resolve(false);
            }
        });
    }
    /**
     * 添加各种EventListener
     *
     * @protected
     * @memberof Options
     */
    _init() {
        this._ws.onerror = data => {
            this.close();
            if (typeof this.onwserror === 'function')
                this.onwserror(data);
            else
                console.error(data);
        };
        this._ws.onclose = data => {
            this.close();
            if (typeof this.onwsclose === 'function')
                this.onwsclose(data);
            else
                console.error(data);
        };
        this._ws.onmessage = async (data) => {
            const Data = data.data;
            let message;
            if (typeof Data === 'string')
                message = JSON.parse(Data);
            else {
                const msg = new Blob([Data]);
                if (this.__crypto) {
                    const aesdata = new Uint8Array(await msg.arrayBuffer());
                    const iv = aesdata.slice(0, 12);
                    const encrypted = aesdata.slice(12);
                    const decrypted = await window.crypto.subtle.decrypt({
                        name: "AES-GCM",
                        iv: iv
                    }, this.__sharedSecret, encrypted);
                    const decoder = new Blob([decrypted]);
                    const decoded = await decoder.text();
                    message = JSON.parse(decoded);
                }
                else
                    message = JSON.parse(await msg.text());
            }
            const ts = message.ts;
            if (ts != null && typeof this.__callback[ts] === 'function') {
                delete message.ts;
                this.__callback[ts](message);
                delete this.__callback[ts];
            }
            else if (message.cmd === 'log' && typeof this.onlog === 'function')
                this.onlog(message.msg);
            else if (typeof this.onerror === 'function')
                this.onerror(data);
            else
                console.error(data);
        };
    }
    /**
     * 向服务器发送消息
     *
     * @protected
     * @template T
     * @param {message} message
     * @returns {Promise<T>}
     * @memberof Options
     */
    _send(message) {
        return new Promise(async (resolve, reject) => {
            const timeout = setTimeout(() => {
                reject('timeout');
            }, 30 * 1000); // 30秒
            const ts = this._ts;
            message.ts = ts;
            this.__callback[ts] = (msg) => {
                clearTimeout(timeout);
                resolve(msg);
            };
            const msg = JSON.stringify(message);
            if (this._ws.readyState === WebSocket.OPEN) {
                if (this.__crypto) {
                    const iv = window.crypto.getRandomValues(new Uint8Array(12));
                    const encoder = new Blob([msg]);
                    const encoded = await encoder.arrayBuffer();
                    const encrypted = await window.crypto.subtle.encrypt({
                        name: "AES-GCM",
                        iv: iv
                    }, this.__sharedSecret, encoded);
                    const aesdata = new Uint8Array([...iv, ...new Uint8Array(encrypted)]);
                    this._ws.send(aesdata);
                }
                else
                    this._ws.send(msg);
            }
            else
                reject('closed');
        });
    }
    /**
     * 关闭连接
     *
     * @memberof Options
     */
    close() {
        this._ws.close();
        this.__callback = {};
    }
    /**
     * 获取Log
     *
     * @returns {Promise<logMSG>}
     * @memberof Options
     */
    getLog() {
        const message = { cmd: 'getLog' };
        return this._send(message);
    }
    /**
     * 获取设置
     *
     * @returns {Promise<configMSG>}
     * @memberof Options
     */
    getConfig() {
        const message = { cmd: 'getConfig' };
        return this._send(message);
    }
    /**
     * 保存设置
     *
     * @param {config} data
     * @returns {Promise<configMSG>}
     * @memberof Options
     */
    setConfig(data) {
        const message = { cmd: 'setConfig', data };
        return this._send(message);
    }
    /**
     * 获取设置描述
     *
     * @returns {Promise<infoMSG>}
     * @memberof Options
     */
    getInfo() {
        const message = { cmd: 'getInfo' };
        return this._send(message);
    }
    /**
     * 获取uid
     *
     * @returns {Promise<userMSG>}
     * @memberof Options
     */
    getAllUID() {
        const message = { cmd: 'getAllUID' };
        return this._send(message);
    }
    /**
     * 获取用户设置
     *
     * @param {string} uid
     * @returns {Promise<userDataMSG>}
     * @memberof Options
     */
    getUserData(uid) {
        const message = { cmd: 'getUserData', uid };
        return this._send(message);
    }
    /**
     * 保存用户设置
     *
     * @param {string} uid
     * @param {userData} data
     * @param {string} [captcha]
     * @param {string} [validate]
     * @param {string} [authcode]
     * @returns {Promise<userDataMSG>}
     * @memberof Options
     */
    setUserData(uid, data, captcha, validate, authcode) {
        const message = { cmd: 'setUserData', uid, data };
        if (captcha !== undefined)
            message.captcha = captcha;
        else if (validate !== undefined)
            message.validate = validate;
        else if (authcode !== undefined)
            message.authcode = authcode;
        return this._send(message);
    }
    /**
     * 删除用户
     *
     * @param {string} uid
     * @returns {Promise<userDataMSG>}
     * @memberof Options
     */
    delUserData(uid) {
        const message = { cmd: 'delUserData', uid };
        return this._send(message);
    }
    /**
     * 设置新用户
     *
     * @returns {Promise<userDataMSG>}
     * @memberof Options
     */
    newUserData() {
        const message = { cmd: 'newUserData' };
        return this._send(message);
    }
}
