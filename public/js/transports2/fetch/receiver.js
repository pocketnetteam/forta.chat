class FetchReceiver {
    onmessageListeners = {};

    constructor(broadcastChannelName) {
        this.broadcastChannel = new BroadcastChannel(broadcastChannelName);

        this.broadcastChannel.onmessage = async ({data: message}) => {
            const hasListenersForId = (message.id in this.onmessageListeners);
            const hasListenersMessage = (message.id in this.onmessageListeners);

            if (!hasListenersForId && !hasListenersMessage) {
                return;
            }

            this.onmessageListeners?.[message.id]?.[message.name](message.data);
        };
    }

    generateId() {
        return (Math.random() + 1).toString(36).substring(2);
    }

    async send(eventName, requestId, data) {
        const message = {
            name: eventName,
            id: requestId,
        };

        if (data) {
            message.data = data;
        }

        this.broadcastChannel.postMessage(message);
    }

    listen(eventName, requestId, listener) {
        this.onmessageListeners[requestId][eventName] = async (data) => {
            listener(data);
        };
    }

    unlisten(eventName, requestId) {
        delete this.onmessageListeners[requestId][eventName];
    }

    unlistenAll(requestId) {
        delete this.onmessageListeners[requestId];
    }

    sendRequest(requestId, request) {
        this.send('Request', requestId, request);
    }

    sendAbort(requestId) {
        this.send('Abort', requestId);
    }

    onInitialData(requestId, listener) {
        this.listen('InitialData', requestId, listener);
    }

    onData(requestId, listener) {
        this.listen('Data', requestId, listener);
    }

    offData(requestId) {
        this.unlisten('Data', requestId);
    }

    onEnd(requestId, listener) {
        this.listen('End', requestId, listener);
    }

    offEnd(requestId) {
        this.unlisten('End', requestId);
    }

    onError(requestId, listener) {
        this.listen('Error', requestId, listener);
    }

    offError(requestId) {
        this.unlisten('Error', requestId);
    }

    offAll(requestId) {
        this.unlistenAll(requestId);
    }

    static init(broadcastChannelName) {
        const serializeRequest = (request) => {
            const instanceToObject = (instance) => {
                const originalClass = instance || {};
                const keys = Object.getOwnPropertyNames(Object.getPrototypeOf(originalClass));

                return keys.reduce((classAsObj, key) => {
                    if (typeof originalClass[key] === 'function') {
                        return classAsObj;
                    }

                    classAsObj[key] = originalClass[key];
                    return classAsObj;
                }, {});
            }
            const prepareHeaders = (headers) => {
                const preparedHeaders = {};

                const isInstanceHeaders = (headers instanceof Headers);

                if (!isInstanceHeaders) {
                    return headers;
                }

                for (let header of request.headers.entries()) {
                    const name = header[0];
                    const value = header[1];

                    preparedHeaders[name] = value;
                }

                return preparedHeaders;
            };

            const preparedRequest = {};

            let requestObject = request;

            if (request instanceof Request) {
                requestObject = instanceToObject(request);
            }

            const requestParams = Object.keys(requestObject);

            for (let i = 0; i < requestParams.length; i++) {
                const paramName = requestParams[i];

                switch (paramName) {
                    case 'body':
                        preparedRequest.body = request.arrayBuffer();
                        break;
                    case 'headers':
                        preparedRequest.headers = prepareHeaders(requestObject.headers);
                        break;
                    case 'signal':
                        //abortSignal.onabort = () => self.sendAbort(requestId);
                        break;
                    default:
                        preparedRequest[paramName] = requestObject[paramName];
                }
            }

            return preparedRequest;
        }

        const self = new FetchReceiver(broadcastChannelName);

        return function(input, init) {
            let reqUrl;
            const requestId = self.generateId();

            self.onmessageListeners[requestId] = {};

            const abortController = new AbortController();
            const abortSignal = abortController.signal;

            const override1 = async (url, options = {}) => {
                reqUrl = url;

                const serializedOptions = serializeRequest(options);

                serializedOptions.body = await serializedOptions.body;

                if (serializedOptions.body.byteLength === 0) {
                    delete serializedOptions.body;
                }

                if (abortSignal.aborted) {
                    return;
                }

                self.sendRequest(requestId, { ...serializedOptions, url });
            };

            const override2 = async (request, options = {}) => {
                reqUrl = request.url;

                const serializedPart1 = serializeRequest(request);
                const serializedPart2 = serializeRequest(options);

                const serializedOptions = { ...serializedPart1, ...serializedPart2 };

                serializedOptions.body = await serializedOptions.body;

                if (serializedOptions.body.byteLength === 0) {
                    delete serializedOptions.body;
                }

                if (abortSignal.aborted) {
                    return;
                }

                self.sendRequest(requestId, serializedOptions);
            };

            const abortError = () => new DOMException('The user aborted a request.', 'AbortError');
            let streamController = null;

            let readStream = new ReadableStream({
                async start(controller) {
                    streamController = controller;

                    abortSignal.onabort = () => {
                        self.sendAbort(requestId);
                        self.offAll(requestId);
                        // A cut-off body must not read as a complete one.
                        controller.error(abortError());
                    };

                    self.onData(requestId, (data) => {
                        const chunkUint8 = new Uint8Array(data);
                        controller.enqueue(chunkUint8);
                    });

                    self.onEnd(requestId, () => {
                        self.offAll(requestId);
                        controller.close();
                    });
                },

                // The page stopped reading the body (aborted or dropped the response).
                cancel() {
                    abortController.abort();
                }
            });

            return new Promise((resolve, reject) => {
                self.onInitialData(requestId, (initialData) => {
                    const isNullBodyStatus = FetchReceiver.NullBytesStatuses.includes(initialData.status);

                    if (isNullBodyStatus) {
                        readStream = null;
                        self.offAll(requestId);
                    }

                    const response = new Response(readStream, initialData);

                    Object.defineProperty(response, 'url', { value: reqUrl });

                    const responseData = { url: response.url };

                    response.headers.forEach((value, name) => {
                        responseData[name] = value;
                    });

                    resolve(response);
                });

                self.onError(requestId, (err) => {
                    self.offAll(requestId);
                    // After InitialData the promise is settled: the body has to fail instead.
                    streamController?.error(new TypeError('Failed to fetch'));
                    reject(err);
                });

                // The main process stops the transfer and sends nothing back.
                abortSignal.addEventListener('abort', () => reject(abortError()));

                // A page cancelling its fetch reaches the SW as the request's signal.
                const callerSignal = init?.signal || (input instanceof Request ? input.signal : null);

                if (callerSignal) {
                    if (callerSignal.aborted) {
                        abortController.abort();
                    } else {
                        callerSignal.addEventListener('abort', () => abortController.abort(), { once: true });
                    }
                }

                if (typeof input === 'string') {
                    return override1(input, init);
                }

                return override2(input, init);
            });
        };
    }

    static NullBytesStatuses = [101, 103, 204, 205, 304];
}

self.FetchReceiver = FetchReceiver;
