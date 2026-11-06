// ==UserScript==
// @name         TwitchAdSolutions - VAFT (Player-Safe Updated Edition)
// @namespace    https://github.com/DrV1rus/twitch-adblock-v1
// @version      69.1.0
// @description  Блокирует видеорекламу Twitch (VAFT) с защитой веб-плеера от бесконечной буферизации, чёрного экрана и ошибок #2000/#3000.
// @author       pixeltris / ryanbr (Updated player-safe config) /DrV1rus for partial update
// @match        *://*.twitch.tv/*
// @updateURL    https://raw.githubusercontent.com/DrV1rus/twitch-adblock-v1/main/vaft-updated.user.js
// @downloadURL  https://raw.githubusercontent.com/DrV1rus/twitch-adblock-v1/main/vaft-updated.user.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const ourTwitchAdSolutionsVersion = 36;
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'embed',
            'picture-by-picture',
            'autoplay'
        ];
        scope.FallbackPlayerType = 'embed';
        scope.ForceAccessTokenPlayerType = 'popout';
        scope.SkipPlayerReloadOnHevc = false;

        // Настройки стабильности плеера (предотвращение чёрного экрана и бесконечной буферизации)
        scope.AlwaysReloadPlayerOnAd = false;
        scope.ReloadPlayerAfterAd = false;
        scope.PlayerReloadMinimalRequestsTime = 1500;
        scope.PlayerReloadLowResTime = 1500;

        // Защита от зависаний буфера (без «снежного кома» из частых пауз/перезапусков)
        scope.PlayerBufferingFix = true;
        scope.FixPlayerBufferingInsideAds = true;
        scope.FixPlayerBufferingOutsideAds = false;
        scope.PlayerBufferingDoPlayerReload = false;
        scope.PlayerBufferingDelay = 1000;
        scope.PlayerBufferingSameStateCount = 4;
        scope.PlayerBufferingMinRepeatDelay = 15000;
        scope.DelayBetweenEachPlayerFixBufferAttempt = 15000;
        scope.PlayerBufferingCheckPosition = true;

        scope.StreamInfos = [];
        scope.StreamInfosByUrl = [];
        scope.CurrentChannelNameFromM3U8 = null;
        scope.GQLDeviceID = null;
        scope.ClientVersion = null;
        scope.ClientSession = null;
        scope.ClientIntegrityHeader = null;
        scope.AuthorizationHeader = undefined;
        scope.SimulatedAdsDepth = 0;
        scope.V2API = false;
        scope.IsAdStrippingEnabled = true;
        scope.AdSegmentCache = new Map();
        scope.AllSegmentsAreAdSegments = false;
    }

    const twitchWorkers = [];
    const workerStringConflicts = [
        'twitch',
        'isVariantA'
    ];
    const workerStringAllow = [];
    const workerStringReinsert = [
        'KBP2',
        'wasm',
        'importScripts'
    ];

    function isWorkerDoubleHooked(worker, checkType) {
        let target = worker ? worker : pageWindow.Worker;
        while (target) {
            const str = target.toString();
            if (checkType === 'twitch') {
                if (str.includes('twitch') || str.includes('hookWorkerFetch')) {
                    return true;
                }
            }
            target = Object.getPrototypeOf(target);
        }
        return false;
    }

    function getCleanWorker(worker) {
        let root = worker;
        let proto = Object.getPrototypeOf(root);
        while (proto && proto !== Function.prototype) {
            const str = proto.toString();
            let hasConflict = false;
            for (let i = 0; i < workerStringConflicts.length; i++) {
                if (str.includes(workerStringConflicts[i])) {
                    hasConflict = true;
                    break;
                }
            }
            if (!hasConflict) {
                break;
            }
            root = proto;
            proto = Object.getPrototypeOf(root);
        }
        return root;
    }

    function getWorkersForReinsert(worker) {
        const result = [];
        let target = worker;
        while (target && target !== Function.prototype) {
            const str = target.toString();
            for (let i = 0; i < workerStringReinsert.length; i++) {
                if (str.includes(workerStringReinsert[i])) {
                    result.push(target);
                    break;
                }
            }
            target = Object.getPrototypeOf(target);
        }
        return result;
    }

    function reinsertWorkers(worker, reinsert) {
        let current = worker;
        for (let i = 0; i < reinsert.length; i++) {
            try {
                Object.setPrototypeOf(reinsert[i], current);
                current = reinsert[i];
            } catch (err) {
                console.warn('[VAFT] Не удалось перевставить обёртку Worker:', err);
            }
        }
        return current;
    }

    function isValidWorker(worker) {
        const str = worker.toString();
        for (let i = 0; i < workerStringConflicts.length; i++) {
            if (str.includes(workerStringConflicts[i])) {
                return false;
            }
        }
        for (let i = 0; i < workerStringAllow.length; i++) {
            if (str.includes(workerStringAllow[i])) {
                return true;
            }
        }
        return true;
    }

    function hookWindowWorker() {
        const reinsert = getWorkersForReinsert(pageWindow.Worker);
        const cleanWorker = getCleanWorker(pageWindow.Worker);

        const newWorker = class Worker extends cleanWorker {
            constructor(twitchBlobUrl, options) {
                let isTwitchWorker = false;
                try {
                    isTwitchWorker = typeof twitchBlobUrl === 'string' && twitchBlobUrl.startsWith('blob:');
                } catch (e) {
                    isTwitchWorker = false;
                }

                if (!isTwitchWorker || !isValidWorker(cleanWorker)) {
                    super(twitchBlobUrl, options);
                    return;
                }

                const newBlobStr = `
                    const ourTwitchAdSolutionsVersion = ${ourTwitchAdSolutionsVersion};
                    ${getStreamUrlForResolution.toString()}
                    ${getStreamForResolution.toString()}
                    ${stripUnusedParams.toString()}
                    ${hookWorkerFetch.toString()}
                    ${ublockProcessM3U8.toString()}
                    ${processM3U8.toString()}
                    ${getAccessToken.toString()}
                    ${gqlRequest.toString()}
                    ${makeGraphQlPacket.toString()}
                    ${tryNotifyTwitch.toString()}
                    ${parseAttributes.toString()}
                    ${getServerTimeFromM3u8.toString()}
                    ${replaceServerTimeInM3u8.toString()}
                    ${getAdSegmentCleanM3u8.toString()}
                    ${declareOptions.toString()}
                    const WasmWorkerJs = ${getWasmWorkerJs.toString()}(${JSON.stringify(twitchBlobUrl.replace(/'/g, "\\'"))});
                    declareOptions(self);
                    self.addEventListener('message', function(e) {
                        if (!e.data) return;
                        if (e.data.key === 'UpdateIsPlayerBuffering') {
                            IsPlayerBuffering = e.data.value;
                        } else if (e.data.key === 'UpdateClientVersion') {
                            ClientVersion = e.data.value;
                        } else if (e.data.key === 'UpdateClientSession') {
                            ClientSession = e.data.value;
                        } else if (e.data.key === 'UpdateClientId') {
                            ClientID = e.data.value;
                        } else if (e.data.key === 'UpdateDeviceId') {
                            GQLDeviceID = e.data.value;
                        } else if (e.data.key === 'UpdateClientIntegrityHeader') {
                            ClientIntegrityHeader = e.data.value;
                        } else if (e.data.key === 'UpdateAuthorizationHeader') {
                            AuthorizationHeader = e.data.value;
                        } else if (e.data.key === 'FetchResponse') {
                            const responseData = e.data.value;
                            if (PendingFetchRequests.has(responseData.id)) {
                                const { resolve, reject } = PendingFetchRequests.get(responseData.id);
                                PendingFetchRequests.delete(responseData.id);
                                if (responseData.error) {
                                    reject(new Error(responseData.error));
                                } else {
                                    const responseObj = new Response(responseData.body, {
                                        status: responseData.status,
                                        statusText: responseData.statusText,
                                        headers: responseData.headers
                                    });
                                    Object.defineProperty(responseObj, 'url', { value: responseData.url });
                                    resolve(responseObj);
                                }
                            }
                        }
                    });
                    hookWorkerFetch();
                    eval(WasmWorkerJs);
                `;

                super(URL.createObjectURL(new Blob([newBlobStr], { type: 'text/javascript' })), options);
                twitchWorkers.push(this);

                this.addEventListener('message', (e) => {
                    if (!e.data) return;
                    if (e.data.key === 'ShowAdBlockBanner') {
                        updateAdBlockBanner(true, e.data.isMidroll);
                    } else if (e.data.key === 'HideAdBlockBanner') {
                        updateAdBlockBanner(false, false);
                    } else if (e.data.key === 'PauseResumePlayer') {
                        doTwitchPlayerTask(true, false);
                    } else if (e.data.key === 'ReloadPlayer') {
                        doTwitchPlayerTask(false, true);
                    } else if (e.data.key === 'FetchRequest') {
                        handleWorkerFetchRequest(this, e.data.value);
                    }
                });
            }
        };

        pageWindow.Worker = reinsertWorkers(newWorker, reinsert);
    }

    function getWasmWorkerJs(twitchBlobUrl) {
        const req = new XMLHttpRequest();
        req.open('GET', twitchBlobUrl, false);
        req.send();
        return req.responseText;
    }

    async function handleWorkerFetchRequest(worker, requestData) {
        try {
            const response = await pageWindow.fetch(requestData.url, requestData.options);
            const body = await response.text();
            const headers = {};
            response.headers.forEach((val, key) => {
                headers[key] = val;
            });
            worker.postMessage({
                key: 'FetchResponse',
                value: {
                    id: requestData.id,
                    status: response.status,
                    statusText: response.statusText,
                    headers: headers,
                    url: response.url,
                    body: body
                }
            });
        } catch (err) {
            worker.postMessage({
                key: 'FetchResponse',
                value: {
                    id: requestData.id,
                    error: err ? err.message : 'Fetch error'
                }
            });
        }
    }

    function hookWorkerFetch() {
        console.log('[VAFT] hookWorkerFetch (vaft player-safe active)');
        const realFetch = fetch;
        self.PendingFetchRequests = new Map();
        self.FetchRequestId = 0;

        fetch = async function (url, options) {
            if (typeof url === 'string') {
                url = url.trim();
                if (url.endsWith('m3u8') || url.includes('.m3u8?')) {
                    return new Promise(function (resolve, reject) {
                        const processAfter = async function (response) {
                            try {
                                if (response.status === 200) {
                                    const text = await response.text();
                                    const processedText = await processM3U8(url, text, realFetch);
                                    resolve(new Response(processedText, {
                                        status: response.status,
                                        statusText: response.statusText,
                                        headers: response.headers
                                    }));
                                } else {
                                    resolve(response);
                                }
                            } catch (err) {
                                console.warn('[VAFT] Ошибка обработки M3U8, возврат исходного потока во избежание поломки плеера:', err);
                                resolve(response);
                            }
                        };
                        realFetch(url, options).then(processAfter).catch(reject);
                    });
                }
                if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^/]+)(?=\.\w+$)/)[0];
                    CurrentChannelNameFromM3U8 = channelName;
                    if (ForceAccessTokenPlayerType) {
                        const tempUrl = new URL(url);
                        tempUrl.searchParams.delete('parent_domains');
                        url = tempUrl.toString();
                    }
                    return new Promise(async function (resolve, reject) {
                        try {
                            const response = await realFetch(url, options);
                            if (response.status === 200) {
                                const encodingsM3u8 = await response.text();
                                const streamInfo = await ublockProcessM3U8(channelName, encodingsM3u8, realFetch);
                                resolve(new Response(streamInfo, {
                                    status: response.status,
                                    statusText: response.statusText,
                                    headers: response.headers
                                }));
                            } else {
                                resolve(response);
                            }
                        } catch (err) {
                            console.warn('[VAFT] Ошибка инициализации мастер-плейлиста, откат к стандартному потоку:', err);
                            realFetch(url, options).then(resolve).catch(reject);
                        }
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }

    async function ublockProcessM3U8(channelName, encodingsM3u8, realFetch) {
        let streamInfo = StreamInfos[channelName];
        if (!streamInfo) {
            StreamInfos[channelName] = streamInfo = {
                ChannelName: channelName,
                IsShowingAd: false,
                LastPlayerReload: 0,
                EncodingsM3U8: encodingsM3u8,
                EncodingsM3U8Cache: [],
                UsherParams: (new URL('https://usher.ttvnw.net/api/channel/hls/' + encodingsM3u8.split('\n')[0])).search,
                RequestedAds: new Set(),
                Urls: [],
                ResolutionList: [],
                BackupEncodingsStatus: new Map(),
                ActiveBackupPlayerType: null,
                IsMidroll: false
            };
        } else {
            streamInfo.EncodingsM3U8 = encodingsM3u8;
        }

        const lines = encodingsM3u8.replace('\r', '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith('#') && lines[i].includes('.m3u8')) {
                StreamInfosByUrl[lines[i].trim()] = streamInfo;
                if (i > 0 && lines[i - 1].startsWith('#EXT-X-STREAM-INF')) {
                    const attributes = parseAttributes(lines[i - 1]);
                    const resolution = attributes['RESOLUTION'];
                    if (resolution) {
                        const frameRate = attributes['FRAME-RATE'] || '30';
                        streamInfo.Urls[lines[i].trim()] = {
                            Resolution: resolution,
                            FrameRate: frameRate,
                            QualityName: attributes['VIDEO'] || resolution
                        };
                        streamInfo.ResolutionList.push({
                            Resolution: resolution,
                            FrameRate: frameRate,
                            Codecs: attributes['CODECS'] || 'avc1',
                            Url: lines[i].trim()
                        });
                    }
                }
            }
        }
        return encodingsM3u8;
    }

    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.replace('\r', '').split('\n');
        let firstUrl = null;
        let lastUrl = null;
        let matchedResolutionUrl = null;
        let matchedFrameRate = false;

        for (let i = 0; i < encodingsLines.length - 1; i++) {
            if (encodingsLines[i].startsWith('#EXT-X-STREAM-INF') && encodingsLines[i + 1].includes('.m3u8')) {
                const attributes = parseAttributes(encodingsLines[i]);
                const resolution = attributes['RESOLUTION'];
                const frameRate = attributes['FRAME-RATE'];
                const url = encodingsLines[i + 1].trim();

                if (!firstUrl) firstUrl = url;
                lastUrl = url;

                if (resolution && resolutionInfo && resolution === resolutionInfo.Resolution) {
                    if (!matchedResolutionUrl || (!matchedFrameRate && frameRate === resolutionInfo.FrameRate)) {
                        matchedResolutionUrl = url;
                        if (frameRate === resolutionInfo.FrameRate) {
                            matchedFrameRate = true;
                        }
                    }
                }
            }
        }
        return matchedResolutionUrl || firstUrl || lastUrl;
    }

    async function getStreamForResolution(streamInfo, resolutionInfo, encodingsM3u8, fallbackStreamStr, playerType, realFetch) {
        let playerTypes = streamInfo.EncodingsM3U8Cache[playerType];
        if (playerTypes) {
            if (Date.now() - playerTypes.RequestTime <= 15000) {
                encodingsM3u8 = playerTypes.Value;
            } else {
                streamInfo.EncodingsM3U8Cache[playerType] = null;
            }
        }

        if (!encodingsM3u8) {
            try {
                const accessTokenResponse = await getAccessToken(streamInfo.ChannelName, playerType, realFetch);
                if (accessTokenResponse && accessTokenResponse.status === 200) {
                    const accessToken = await accessTokenResponse.json();
                    const tokenData = accessToken?.data?.streamPlaybackAccessToken;
                    if (tokenData && tokenData.value && tokenData.signature) {
                        const urlInfo = new URL(`https://usher.ttvnw.net/api/${V2API ? 'v2/' : ''}channel/hls/${streamInfo.ChannelName}.m3u8${streamInfo.UsherParams}`);
                        urlInfo.searchParams.set('sig', tokenData.signature);
                        urlInfo.searchParams.set('token', tokenData.value);
                        const encodingsM3u8Response = await realFetch(urlInfo.href);
                        if (encodingsM3u8Response.status === 200) {
                            encodingsM3u8 = await encodingsM3u8Response.text();
                            streamInfo.EncodingsM3U8Cache[playerType] = {
                                RequestTime: Date.now(),
                                Value: encodingsM3u8
                            };
                        }
                    }
                }
            } catch (err) {
                console.warn(`[VAFT] Не удалось получить токен для типа плеера ${playerType}:`, err);
            }
        }

        if (encodingsM3u8) {
            try {
                const streamUrl = getStreamUrlForResolution(encodingsM3u8, resolutionInfo);
                if (streamUrl) {
                    const streamResponse = await realFetch(streamUrl);
                    if (streamResponse.status === 200) {
                        const m3u8Text = await streamResponse.text();
                        if (m3u8Text && !m3u8Text.includes(AdSignifier)) {
                            return {
                                PlayerType: playerType,
                                M3U8: m3u8Text
                            };
                        } else if (m3u8Text) {
                            fallbackStreamStr = m3u8Text;
                        }
                    }
                }
            } catch (err) {
                console.warn(`[VAFT] Сбой загрузки резервного потока (${playerType}):`, err);
            }
        }
        return {
            PlayerType: null,
            M3U8: fallbackStreamStr
        };
    }

    function getServerTimeFromM3u8(encodingsM3u8) {
        if (!encodingsM3u8) return null;
        const matches = encodingsM3u8.match(/#EXT-X-TWITCH-INFO:.*SERVER-TIME="([0-9.]+)"/);
        return matches && matches.length > 1 ? matches[1] : null;
    }

    function replaceServerTimeInM3u8(encodingsM3u8, newServerTime) {
        if (!encodingsM3u8 || !newServerTime) return encodingsM3u8;
        return encodingsM3u8.replace(
            /(#EXT-X-TWITCH-INFO:.*SERVER-TIME=")[0-9.]+(")/,
            `$1${newServerTime}$2`
        );
    }

    function getAdSegmentCleanM3u8(m3u8Text) {
        if (!m3u8Text) return m3u8Text;
        const lines = m3u8Text.replace(/\r/g, '').split('\n');
        const cleanLines = [];
        let hasLiveSegments = false;

        // Проверяем, есть ли хотя бы один живой (не рекламный) сегмент в плейлисте
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXTINF') && !lines[i].includes('Amazon') && !lines[i].includes('AD')) {
                let isAdSegment = false;
                for (let j = Math.max(0, i - 3); j <= i; j++) {
                    if (lines[j].includes('stitched-ad') || lines[j].includes('EXT-X-DATERANGE')) {
                        isAdSegment = true;
                        break;
                    }
                }
                if (!isAdSegment) {
                    hasLiveSegments = true;
                    break;
                }
            }
        }

        // Если в плейлисте есть чистые сегменты, аккуратно вырезаем рекламные;
        // если ВСЕ сегменты рекламные, не удаляем всё целиком (чтобы HLS-плеер не завис с пустым плейлистом)
        if (!hasLiveSegments) {
            return m3u8Text;
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('EXT-X-DATERANGE') && line.includes(AdSignifier)) {
                continue;
            }
            if (line.startsWith('#EXTINF') && line.includes('Amazon')) {
                i++; // Пропускаем URL рекламного сегмента
                continue;
            }
            cleanLines.push(line);
        }
        return cleanLines.join('\n');
    }

    async function processM3U8(url, textStr, realFetch) {
        const streamInfo = StreamInfosByUrl[url];
        if (!streamInfo) {
            return textStr;
        }

        const haveAdTags = textStr.includes(AdSignifier);

        if (!haveAdTags) {
            if (streamInfo.IsShowingAd) {
                console.log('[VAFT] Рекламный блок завершён, возврат к основному потоку');
                streamInfo.IsShowingAd = false;
                streamInfo.ActiveBackupPlayerType = null;
                postMessage({ key: 'HideAdBlockBanner' });
                if (ReloadPlayerAfterAd) {
                    postMessage({ key: 'ReloadPlayer' });
                } else {
                    // Мягкая синхронизация буфера через 1 секунду после окончания рекламы без перезагрузки плеера
                    setTimeout(() => {
                        postMessage({ key: 'PauseResumePlayer' });
                    }, 1000);
                }
            }
            return textStr;
        }

        streamInfo.IsMidroll = textStr.includes('"MIDROLL"') || textStr.includes('midroll');
        if (!streamInfo.IsShowingAd) {
            console.log(`[VAFT] Обнаружена реклама (${streamInfo.IsMidroll ? 'mid-roll' : 'pre-roll'}), переключение на чистый резервный поток...`);
            streamInfo.IsShowingAd = true;
            postMessage({
                key: 'ShowAdBlockBanner',
                isMidroll: streamInfo.IsMidroll
            });
            if (AlwaysReloadPlayerOnAd) {
                postMessage({ key: 'ReloadPlayer' });
            }
        }

        const currentResolution = streamInfo.Urls[url];
        const serverTime = getServerTimeFromM3u8(textStr);
        let fallbackM3u8 = textStr;

        // Сначала проверяем уже найденный рабочий резервный тип плеера
        const candidatePlayerTypes = [...BackupPlayerTypes];
        if (streamInfo.ActiveBackupPlayerType && candidatePlayerTypes.includes(streamInfo.ActiveBackupPlayerType)) {
            candidatePlayerTypes.splice(candidatePlayerTypes.indexOf(streamInfo.ActiveBackupPlayerType), 1);
            candidatePlayerTypes.unshift(streamInfo.ActiveBackupPlayerType);
        }

        for (let i = 0; i < candidatePlayerTypes.length; i++) {
            const playerType = candidatePlayerTypes[i];
            const result = await getStreamForResolution(
                streamInfo,
                currentResolution,
                null,
                fallbackM3u8,
                playerType,
                realFetch
            );
            if (result.PlayerType && result.M3U8) {
                streamInfo.ActiveBackupPlayerType = result.PlayerType;
                return replaceServerTimeInM3u8(result.M3U8, serverTime);
            }
            if (result.M3U8) {
                fallbackM3u8 = result.M3U8;
            }
        }

        // Если ни один резервный тип плеера не вернул полностью чистый плейлист,
        // аккуратно очищаем плейлист от рекламных сегментов с сохранением SERVER-TIME
        if (IsAdStrippingEnabled && fallbackM3u8) {
            return replaceServerTimeInM3u8(getAdSegmentCleanM3u8(fallbackM3u8), serverTime);
        }

        return replaceServerTimeInM3u8(fallbackM3u8, serverTime);
    }

    function parseAttributes(str) {
        return Object.fromEntries(
            str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
                .filter(Boolean)
                .map(x => {
                    const idx = x.indexOf('=');
                    const key = x.substring(0, idx).trim();
                    let val = x.substring(idx + 1).trim();
                    if (val.startsWith('"') && val.endsWith('"')) {
                        val = val.substring(1, val.length - 1);
                    }
                    return [key, val];
                })
        );
    }

    function stripUnusedParams(str, params) {
        if (!params) {
            params = ['token', 'sig'];
        }
        const tempUrl = new URL('https://localhost/' + str);
        for (let i = 0; i < params.length; i++) {
            tempUrl.searchParams.delete(params[i]);
        }
        return tempUrl.pathname.substring(1) + tempUrl.search;
    }

    async function tryNotifyTwitch(streamM3u8) {
        return true;
    }

    function gqlRequest(body, realFetch) {
        const headers = {
            'Client-ID': ClientID,
            'Content-Type': 'text/plain; charset=UTF-8'
        };
        if (GQLDeviceID) headers['X-Device-Id'] = GQLDeviceID;
        if (ClientVersion) headers['Client-Version'] = ClientVersion;
        if (ClientSession) headers['Client-Session-Id'] = ClientSession;
        if (ClientIntegrityHeader) headers['Client-Integrity'] = ClientIntegrityHeader;
        if (AuthorizationHeader) headers['Authorization'] = AuthorizationHeader;

        return new Promise((resolve, reject) => {
            const requestId = ++self.FetchRequestId;
            const timeout = setTimeout(() => {
                if (self.PendingFetchRequests.has(requestId)) {
                    self.PendingFetchRequests.delete(requestId);
                    realFetch('https://gql.twitch.tv/gql', {
                        method: 'POST',
                        body: JSON.stringify(body),
                        headers: headers
                    }).then(resolve).catch(reject);
                }
            }, 4000);

            self.PendingFetchRequests.set(requestId, {
                resolve: (res) => {
                    clearTimeout(timeout);
                    resolve(res);
                },
                reject: (err) => {
                    clearTimeout(timeout);
                    reject(err);
                }
            });

            postMessage({
                key: 'FetchRequest',
                value: {
                    id: requestId,
                    url: 'https://gql.twitch.tv/gql',
                    options: {
                        method: 'POST',
                        body: JSON.stringify(body),
                        headers: headers
                    }
                }
            });
        });
    }

    function getAccessToken(channelName, playerType, realFetch) {
        const body = makeGraphQlPacket('PlaybackAccessToken', '0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712', {
            isLive: true,
            login: channelName,
            isVod: false,
            vodID: '',
            playerType: playerType
        });
        return gqlRequest(body, realFetch);
    }

    function makeGraphQlPacket(operationName, sha256Hash, variables) {
        return [{
            operationName: operationName,
            variables: variables,
            extensions: {
                persistedQuery: {
                    version: 1,
                    sha256Hash: sha256Hash
                }
            }
        }];
    }

    function findReactNode(root, constraint) {
        if (!root) return null;
        if (root.stateNode && constraint(root.stateNode)) {
            return root.stateNode;
        }
        let node = root.child;
        while (node) {
            const result = findReactNode(node, constraint);
            if (result) {
                return result;
            }
            node = node.sibling;
        }
        return null;
    }

    function findReactRootNode() {
        let reactRootNode = null;
        const rootNode = document.querySelector('#root');
        if (rootNode) {
            const reactKey = Object.keys(rootNode).find(k => k.startsWith('__reactContainer') || k.startsWith('_reactRootContainer'));
            if (reactKey) {
                reactRootNode = rootNode[reactKey];
                if (reactRootNode?._internalRoot?.current) {
                    reactRootNode = reactRootNode._internalRoot.current;
                }
            }
        }
        return reactRootNode;
    }

    let lastPlayerTaskTime = 0;

    function doTwitchPlayerTask(isPausePlay, isReload) {
        const now = Date.now();
        // Защита от двойного вызова (Issue #492): не выполняем повторный таск чаще чем раз в 2.5 секунды
        if (now - lastPlayerTaskTime < 2500) {
            return;
        }
        lastPlayerTaskTime = now;

        try {
            const reactRoot = findReactRootNode();
            if (!reactRoot) return;

            const playerNode = findReactNode(reactRoot, node =>
                node.setPlayerActive && node.props && node.props.mediaPlayerInstance
            );
            const player = playerNode?.props?.mediaPlayerInstance;
            if (!player) return;

            // Не вмешиваемся, если пользователь сам поставил плеер на паузу
            if (player.isPaused && player.isPaused()) {
                return;
            }

            if (isPausePlay) {
                player.pause();
                setTimeout(() => {
                    try {
                        player.play();
                    } catch (e) {}
                }, 50);
                return;
            }

            if (isReload) {
                const lsKeyQuality = 'video-quality';
                const lsKeyMuted = 'video-muted';
                const lsKeyVolume = 'volume';
                const currentQuality = localStorage.getItem(lsKeyQuality);
                const currentMuted = localStorage.getItem(lsKeyMuted);
                const currentVolume = localStorage.getItem(lsKeyVolume);

                if (player?.core?.state) {
                    localStorage.setItem(lsKeyMuted, JSON.stringify({ default: player.core.state.muted }));
                    localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                if (player?.core?.state?.quality?.group) {
                    localStorage.setItem(lsKeyQuality, JSON.stringify({ default: player.core.state.quality.group }));
                }

                playerNode.setPlayerActive(false);
                setTimeout(() => {
                    try {
                        playerNode.setPlayerActive(true);
                    } finally {
                        if (currentQuality !== null) localStorage.setItem(lsKeyQuality, currentQuality);
                        if (currentMuted !== null) localStorage.setItem(lsKeyMuted, currentMuted);
                        if (currentVolume !== null) localStorage.setItem(lsKeyVolume, currentVolume);
                    }
                }, 150);
            }
        } catch (err) {
            console.warn('[VAFT] Ошибка выполнения задачи плеера:', err);
        }
    }

    function updateAdBlockBanner(show, isMidroll) {
        try {
            let banner = document.getElementById('vaft-adblock-banner');
            if (!show) {
                if (banner) {
                    banner.style.display = 'none';
                }
                return;
            }
            if (!banner) {
                const playerContainer = document.querySelector('.video-player__overlay, [data-a-target="video-player"]');
                if (!playerContainer) return;
                banner = document.createElement('div');
                banner.id = 'vaft-adblock-banner';
                banner.style.cssText = [
                    'position: absolute',
                    'top: 12px',
                    'left: 12px',
                    'z-index: 9999',
                    'background: rgba(14, 14, 16, 0.82)',
                    'color: #efeff1',
                    'border: 1px solid rgba(145, 71, 255, 0.7)',
                    'border-radius: 6px',
                    'padding: 4px 10px',
                    'font-size: 12px',
                    'font-family: Inter, Roobert, "Helvetica Neue", Helvetica, Arial, sans-serif',
                    'font-weight: 600',
                    'pointer-events: none',
                    'backdrop-filter: blur(4px)'
                ].join(';');
                playerContainer.appendChild(banner);
            }
            banner.textContent = isMidroll ? 'Блокировка рекламы (mid-roll)...' : 'Блокировка рекламы (pre-roll)...';
            banner.style.display = 'block';
        } catch (e) {}
    }

    function setupBufferingMonitor() {
        let lastBufferingFixTime = 0;
        let samePositionCount = 0;
        let lastPosition = -1;

        setInterval(() => {
            if (!pageWindow.PlayerBufferingFix) return;

            const isShowingAd = document.getElementById('vaft-adblock-banner')?.style.display === 'block';
            if (isShowingAd && !pageWindow.FixPlayerBufferingInsideAds) return;
            if (!isShowingAd && !pageWindow.FixPlayerBufferingOutsideAds) return;

            const now = Date.now();
            if (now - lastBufferingFixTime < pageWindow.DelayBetweenEachPlayerFixBufferAttempt) {
                return;
            }

            try {
                const reactRoot = findReactRootNode();
                if (!reactRoot) return;
                const playerNode = findReactNode(reactRoot, node =>
                    node.setPlayerActive && node.props && node.props.mediaPlayerInstance
                );
                const player = playerNode?.props?.mediaPlayerInstance;
                if (!player || (player.isPaused && player.isPaused())) {
                    samePositionCount = 0;
                    return;
                }

                const position = typeof player.getPosition === 'function' ? player.getPosition() : null;
                if (pageWindow.PlayerBufferingCheckPosition && (position === null || position <= 5)) {
                    samePositionCount = 0;
                    return;
                }

                const isBuffering = Boolean(
                    player?.core?.state?.buffering ||
                    document.querySelector('.tw-loading-spinner')
                );

                if (isBuffering && position !== null && Math.abs(position - lastPosition) < 0.05) {
                    samePositionCount++;
                    if (samePositionCount >= pageWindow.PlayerBufferingSameStateCount) {
                        console.log('[VAFT] Обнаружено зависание буфера во время рекламы, мягкий перезапуск воспроизведения...');
                        lastBufferingFixTime = now;
                        samePositionCount = 0;
                        doTwitchPlayerTask(
                            !pageWindow.PlayerBufferingDoPlayerReload,
                            pageWindow.PlayerBufferingDoPlayerReload
                        );
                    }
                } else {
                    samePositionCount = 0;
                }
                if (position !== null) {
                    lastPosition = position;
                }
            } catch (e) {}
        }, pageWindow.PlayerBufferingDelay || 1000);
    }

    function hookFetchForHeaders() {
        const realFetch = pageWindow.fetch;
        pageWindow.fetch = function (url, init) {
            try {
                if (typeof url === 'string' && url.includes('gql.twitch.tv/gql') && init && init.headers) {
                    const headers = init.headers;
                    const getHeader = (name) => {
                        if (headers instanceof Headers) return headers.get(name);
                        return headers[name] || headers[name.toLowerCase()];
                    };
                    const deviceId = getHeader('X-Device-Id') || getHeader('Device-ID');
                    const clientVersion = getHeader('Client-Version');
                    const clientSession = getHeader('Client-Session-Id');
                    const clientIntegrity = getHeader('Client-Integrity');
                    const auth = getHeader('Authorization');

                    for (let i = 0; i < twitchWorkers.length; i++) {
                        if (deviceId) twitchWorkers[i].postMessage({ key: 'UpdateDeviceId', value: deviceId });
                        if (clientVersion) twitchWorkers[i].postMessage({ key: 'UpdateClientVersion', value: clientVersion });
                        if (clientSession) twitchWorkers[i].postMessage({ key: 'UpdateClientSession', value: clientSession });
                        if (clientIntegrity) twitchWorkers[i].postMessage({ key: 'UpdateClientIntegrityHeader', value: clientIntegrity });
                        if (auth) twitchWorkers[i].postMessage({ key: 'UpdateAuthorizationHeader', value: auth });
                    }
                }
            } catch (e) {}
            return realFetch.apply(this, arguments);
        };
    }

    if (isWorkerDoubleHooked(null, 'twitch')) {
        console.warn('[VAFT] Обнаружен другой блокировщик рекламы Twitch (Worker уже перехвачен). Пропуск запуска во избежание поломки плеера.');
    } else {
        declareOptions(pageWindow);
        pageWindow.reloadTwitchPlayer = doTwitchPlayerTask;
        hookWindowWorker();
        hookFetchForHeaders();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupBufferingMonitor);
        } else {
            setupBufferingMonitor();
        }
    }
})();
