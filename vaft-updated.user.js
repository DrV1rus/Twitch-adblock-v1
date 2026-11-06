// ==UserScript==
// @name         TwitchAdSolutions - VAFT + Auto Best Quality 
// @namespace    https://github.com/DrV1rus/twitch-adblock-v1
// @version      69.3.4
// @description  Блокирует видеорекламу Twitch (VAFT) без поломки веб-плеера и удерживает наилучшее качество видео 
// @author       pixeltris / ryanbr / CommanderRoot (fixed)
// @match        *://*.twitch.tv/*
// @updateURL    https://raw.githubusercontent.com/DrV1rus/twitch-adblock-v1/main/vaft-updated.user.js
// @downloadURL  https://raw.githubusercontent.com/DrV1rus/twitch-adblock-v1/main/vaft-updated.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const ourTwitchAdSolutionsVersion = 36;
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const pageDoc = pageWindow.document;

    function declareOptions(scope) {
        scope.AdSignifier = 'stitched';
        scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
        scope.BackupPlayerTypes = [
            'embed',
            'picture-by-picture',
            'autoplay'
        ];
        scope.FallbackPlayerType = 'embed';
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

        // Настройки удержания максимального качества в фоне
        scope.DisableBackgroundDownscale = true;
        scope.ForceBestVideoQuality = true;
        // 'MaxAvailable' = Source (chunked). Можно указать, например, '1080p60'
        scope.PreferredMaxQuality = 'MaxAvailable';
        // Минимальный интервал между принудительными переключениями качества (мс).
        // Частый setQuality() заставляет плеер перезапрашивать плейлисты/сегменты -> ошибка #2000.
        scope.QualityApplyCooldown = 15000;

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

    // =========================================================================
    // БЛОК 1: Запрет сброса качества в неактивной вкладке и авто-выбор Source
    // =========================================================================

    let userManuallyPaused = false;
    let lastQualityApplyTime = 0;

    function isAdBannerShown() {
        return pageDoc.getElementById('vaft-adblock-banner')?.style.display === 'block';
    }

    function setQualitySettingsInStorage() {
        if (!pageWindow.ForceBestVideoQuality) return;
        try {
            pageWindow.localStorage.setItem('s-qs-ts', String(Math.floor(Date.now())));
            pageWindow.localStorage.setItem('quality-bitrate', '9840720');
            // 'chunked' — внутренний идентификатор Source в плеере Twitch
            pageWindow.localStorage.setItem('video-quality', '{"default":"chunked"}');
        } catch (e) {
            console.warn('[VAFT+Quality] Не удалось записать настройки качества в localStorage:', e);
        }
    }

    function applyBestQualityOnPlayerInstance() {
        if (!pageWindow.ForceBestVideoQuality) return;
        // Не трогаем качество посреди рекламного блока (иначе собьём резервный поток)
        if (isAdBannerShown()) return;
        try {
            const reactRoot = findReactRootNode();
            if (!reactRoot) return;

            const playerNode = findReactNode(reactRoot, node =>
                node.setPlayerActive && node.props && node.props.mediaPlayerInstance
            );
            const player = playerNode?.props?.mediaPlayerInstance;
            if (!player || typeof player.getQualities !== 'function' || typeof player.setQuality !== 'function') {
                return;
            }
            if (typeof player.isPaused === 'function' && player.isPaused()) return;

            const qualities = player.getQualities();
            if (!Array.isArray(qualities) || qualities.length === 0) {
                return;
            }

            let targetQuality = qualities[0];
            if (pageWindow.PreferredMaxQuality && pageWindow.PreferredMaxQuality !== 'MaxAvailable') {
                const preferred = qualities.find(q =>
                    q.group === pageWindow.PreferredMaxQuality ||
                    (q.name && q.name.includes(pageWindow.PreferredMaxQuality))
                );
                if (preferred) {
                    targetQuality = preferred;
                }
            } else {
                const chunked = qualities.find(q => q.group === 'chunked');
                if (chunked) {
                    targetQuality = chunked;
                }
            }

            if (!targetQuality || !targetQuality.group) return;

            const currentQuality = typeof player.getQuality === 'function' ? player.getQuality() : null;
            const isAuto = typeof player.isAutoQualityMode === 'function' ? player.isAutoQualityMode() : false;
            const groupMismatch = !currentQuality || currentQuality.group !== targetQuality.group;
            if (!groupMismatch) {
                // Качество уже верное: только выключаем авто-режим, без смены потока
                if (isAuto && typeof player.setAutoQualityMode === 'function') {
                    try {
                        player.setAutoQualityMode(false);
                    } catch (e) {}
                }
                return;
            }

            // Анти-«дребезг»: не переключаем качество чаще, чем раз в QualityApplyCooldown
            const now = Date.now();
            if (now - lastQualityApplyTime < (pageWindow.QualityApplyCooldown || 15000)) return;
            lastQualityApplyTime = now;

            if (typeof player.setAutoQualityMode === 'function') {
                try {
                    player.setAutoQualityMode(false);
                } catch (e) {}
            }
            player.setQuality(targetQuality);
            setQualitySettingsInStorage();
        } catch (e) {}
    }

    function setupAntiDownscaleAndVisibilityOverride() {
        setQualitySettingsInStorage();

        // Сохраняем нативный геттер document.hidden до переопределения
        const docProto = Object.getPrototypeOf(pageDoc) || Document.prototype;
        const nativeHiddenDescriptor =
            Object.getOwnPropertyDescriptor(docProto, 'hidden') ||
            Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ||
            Object.getOwnPropertyDescriptor(pageDoc, 'hidden');

        const isTabActuallyHidden = () => {
            try {
                if (nativeHiddenDescriptor && typeof nativeHiddenDescriptor.get === 'function') {
                    return Boolean(nativeHiddenDescriptor.get.call(pageDoc));
                }
            } catch (e) {}
            return false;
        };

        const initialHidden = isTabActuallyHidden();
        let didInitialPlay = false;
        let lastVideoPlaying = false;

        try {
            const visibilityProps = {
                visibilityState: { get: () => 'visible', configurable: true },
                webkitVisibilityState: { get: () => 'visible', configurable: true },
                hidden: { get: () => false, configurable: true },
                webkitHidden: { get: () => false, configurable: true },
                mozHidden: { get: () => false, configurable: true }
            };

            for (const [prop, desc] of Object.entries(visibilityProps)) {
                try {
                    Object.defineProperty(pageDoc, prop, desc);
                } catch (e) {}
                try {
                    Object.defineProperty(Document.prototype, prop, desc);
                } catch (e) {}
            }

            pageDoc.hasFocus = function () {
                return true;
            };
        } catch (e) {
            console.warn('[VAFT+Quality] Ошибка переопределения Page Visibility API:', e);
        }

        // Отслеживаем ручную паузу пользователем
        pageDoc.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('[data-a-target="player-play-pause-button"]') : null;
            if (btn) {
                const videos = pageDoc.getElementsByTagName('video');
                if (videos.length > 0) {
                    userManuallyPaused = !videos[0].paused;
                }
            }
        }, true);

        function playVideoIfNeeded() {
            if (userManuallyPaused) return;
            const videos = pageDoc.getElementsByTagName('video');
            if (videos.length > 0) {
                if ((didInitialPlay === false || lastVideoPlaying === true) && !videos[0].ended) {
                    videos[0].play().catch(() => {});
                    didInitialPlay = true;
                }
            }
        }

        pageDoc.addEventListener('visibilitychange', function (e) {
            const currentlyHidden = isTabActuallyHidden();
            if (currentlyHidden === false && initialHidden === true && didInitialPlay === false) {
                // Разрешаем однократное прохождение события при открытии стрима в фоновой вкладке
            } else {
                e.stopImmediatePropagation();
            }

            if (currentlyHidden) {
                didInitialPlay = true;
            }

            if (currentlyHidden === true) {
                const videos = pageDoc.getElementsByTagName('video');
                if (videos.length > 0) {
                    lastVideoPlaying = !videos[0].paused && !videos[0].ended && !userManuallyPaused;
                } else {
                    lastVideoPlaying = false;
                }
                setQualitySettingsInStorage();
                setTimeout(applyBestQualityOnPlayerInstance, 250);
            } else {
                playVideoIfNeeded();
                setTimeout(applyBestQualityOnPlayerInstance, 250);
            }
        }, true);

        pageDoc.addEventListener('webkitvisibilitychange', function (e) {
            e.stopImmediatePropagation();
        }, true);

        // SPA-навигация между каналами/клипами
        pageWindow.addEventListener('popstate', () => {
            userManuallyPaused = false;
            setQualitySettingsInStorage();
            setTimeout(applyBestQualityOnPlayerInstance, 800);
        });

        const pageHistory = pageWindow.history;
        const origPushState = pageHistory.pushState;
        if (origPushState) {
            pageHistory.pushState = function () {
                const ret = origPushState.apply(this, arguments);
                userManuallyPaused = false;
                setQualitySettingsInStorage();
                setTimeout(applyBestQualityOnPlayerInstance, 800);
                return ret;
            };
        }

        const origReplaceState = pageHistory.replaceState;
        if (origReplaceState) {
            pageHistory.replaceState = function () {
                const ret = origReplaceState.apply(this, arguments);
                setQualitySettingsInStorage();
                setTimeout(applyBestQualityOnPlayerInstance, 800);
                return ret;
            };
        }

        // Периодический контроль качества (с анти-дребезгом внутри applyBestQualityOnPlayerInstance)
        setInterval(() => {
            if (!pageWindow.ForceBestVideoQuality) return;
            applyBestQualityOnPlayerInstance();
        }, 5000);
    }

    // =========================================================================
    // БЛОК 2: Блокировка рекламы VAFT (Player-Safe Edition)
    // =========================================================================

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
                // Хукаем ТОЛЬКО blob-воркеры самого twitch.tv (и не module-воркеры),
                // иначе можно сломать посторонние воркеры страницы.
                let blobUrlStr = '';
                let isTwitchWorker = false;
                try {
                    blobUrlStr = typeof twitchBlobUrl === 'string'
                        ? twitchBlobUrl
                        : (twitchBlobUrl instanceof URL ? twitchBlobUrl.href : '');
                    isTwitchWorker = blobUrlStr.startsWith('blob:') &&
                        new URL(blobUrlStr).origin.endsWith('.twitch.tv') &&
                        !(options && options.type === 'module');
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
                    ${fetchTextWithTimeout.toString()}
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
                    const WasmWorkerJs = ${getWasmWorkerJs.toString()}(${JSON.stringify(blobUrlStr)});
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
                        // После рекламы возвращаем максимальное качество
                        setQualitySettingsInStorage();
                        setTimeout(applyBestQualityOnPlayerInstance, 1500);
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
        console.log('[VAFT] hookWorkerFetch (vaft player-safe + best-quality active)');
        const realFetch = fetch;
        self.PendingFetchRequests = new Map();
        self.FetchRequestId = 0;

        fetch = async function (url, options) {
            if (typeof url === 'string') {
                url = url.trim();

                // ВАЖНО: мастер-плейлист (usher) проверяем ПЕРВЫМ.
                // Его URL содержит '.m3u8?', поэтому раньше он ошибочно попадал в ветку
                // медиа-плейлистов, StreamInfos никогда не заполнялись, а UsherParams был пустым.
                if (url.includes('/channel/hls/') && !url.includes('picture-by-picture')) {
                    V2API = url.includes('/api/v2/');
                    const channelName = (new URL(url)).pathname.match(/([^/]+)(?=\.\w+$)/)[0];
                    CurrentChannelNameFromM3U8 = channelName;
                    // URL и токен НЕ изменяем: плеер получил токен 'site', и менять
                    // parent_domains без подмены типа токена нельзя (ломает usher -> #2000).
                    try {
                        const response = await realFetch(url, options);
                        if (response.status !== 200) {
                            return response;
                        }
                        const encodingsM3u8 = await response.text();
                        let result = encodingsM3u8;
                        try {
                            result = await ublockProcessM3U8(channelName, encodingsM3u8, realFetch, url);
                        } catch (err) {
                            console.warn('[VAFT] Ошибка обработки мастер-плейлиста, отдаю исходный:', err);
                        }
                        return new Response(result, {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    } catch (err) {
                        console.warn('[VAFT] Ошибка запроса мастер-плейлиста:', err);
                        return realFetch(url, options);
                    }
                }

                if (url.endsWith('m3u8') || url.includes('.m3u8?')) {
                    const response = await realFetch(url, options);
                    if (response.status !== 200) {
                        return response;
                    }
                    // Читаем тело ОДИН раз и сохраняем: если обработка упадёт, отдаём
                    // исходный текст. Раньше возвращался уже прочитанный Response -> #2000.
                    const text = await response.text();
                    let outText = text;
                    try {
                        outText = await processM3U8(url, text, realFetch);
                    } catch (err) {
                        console.warn('[VAFT] Ошибка обработки M3U8, возврат исходного плейлиста:', err);
                        outText = text;
                    }
                    return new Response(outText, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                }
            }
            return realFetch.apply(this, arguments);
        };
    }

    async function ublockProcessM3U8(channelName, encodingsM3u8, realFetch, masterUrl) {
        // Параметры usher берём из РЕАЛЬНОГО URL мастер-плейлиста (allow_source, p, play_session_id и т.д.).
        // Раньше они парсились из строки '#EXTM3U' и всегда были пустыми.
        let usherParams = '';
        try {
            usherParams = (new URL(masterUrl)).search;
        } catch (e) {}

        let streamInfo = StreamInfos[channelName];
        if (!streamInfo) {
            StreamInfos[channelName] = streamInfo = {
                ChannelName: channelName,
                IsShowingAd: false,
                LastPlayerReload: 0,
                EncodingsM3U8: encodingsM3u8,
                EncodingsM3U8Cache: [],
                UsherParams: usherParams,
                RequestedAds: new Set(),
                Urls: [],
                ResolutionList: [],
                BackupEncodingsStatus: new Map(),
                ActiveBackupPlayerType: null,
                IsMidroll: false
            };
        } else {
            streamInfo.EncodingsM3U8 = encodingsM3u8;
            if (usherParams) {
                streamInfo.UsherParams = usherParams;
            }
        }

        const lines = encodingsM3u8.replace(/\r/g, '').split('\n');
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

    // fetch + чтение тела с жёстким таймаутом. Зависший запрос к резервному потоку
    // иначе блокирует ответ на запрос плейлиста плеера -> ошибка #2000.
    async function fetchTextWithTimeout(realFetch, url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await realFetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
            const text = await response.text();
            return { status: response.status, text: text };
        } finally {
            clearTimeout(timer);
        }
    }

    function getStreamUrlForResolution(encodingsM3u8, resolutionInfo) {
        const encodingsLines = encodingsM3u8.replace(/\r/g, '').split('\n');
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
        // Если этот тип плеера недавно не сработал — не тратим время на повтор
        streamInfo.FailedPlayerTypes = streamInfo.FailedPlayerTypes || {};
        const failedAt = streamInfo.FailedPlayerTypes[playerType];
        if (failedAt && Date.now() - failedAt < 10000) {
            return { PlayerType: null, M3U8: fallbackStreamStr };
        }

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
                    const tokenData = accessToken?.[0]?.data?.streamPlaybackAccessToken || accessToken?.data?.streamPlaybackAccessToken;
                    if (tokenData && tokenData.value && tokenData.signature) {
                        const urlInfo = new URL(`https://usher.ttvnw.net/api/${V2API ? 'v2/' : ''}channel/hls/${streamInfo.ChannelName}.m3u8${streamInfo.UsherParams}`);
                        urlInfo.searchParams.set('sig', tokenData.signature);
                        urlInfo.searchParams.set('token', tokenData.value);
                        const encodingsM3u8Response = await fetchTextWithTimeout(realFetch, urlInfo.href, undefined, 4000);
                        if (encodingsM3u8Response.status === 200) {
                            encodingsM3u8 = encodingsM3u8Response.text;
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
            if (!encodingsM3u8) {
                streamInfo.FailedPlayerTypes[playerType] = Date.now();
            }
        }

        if (encodingsM3u8) {
            try {
                const streamUrl = getStreamUrlForResolution(encodingsM3u8, resolutionInfo);
                if (streamUrl) {
                    const streamResponse = await fetchTextWithTimeout(realFetch, streamUrl, undefined, 4000);
                    if (streamResponse.status === 200) {
                        const m3u8Text = streamResponse.text;
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
                streamInfo.FailedPlayerTypes[playerType] = Date.now();
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

        if (!hasLiveSegments) {
            return m3u8Text;
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('EXT-X-DATERANGE') && line.includes(AdSignifier)) {
                continue;
            }
            if (line.startsWith('#EXTINF') && line.includes('Amazon')) {
                i++;
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

        const candidatePlayerTypes = [...BackupPlayerTypes];
        if (streamInfo.ActiveBackupPlayerType && candidatePlayerTypes.includes(streamInfo.ActiveBackupPlayerType)) {
            candidatePlayerTypes.splice(candidatePlayerTypes.indexOf(streamInfo.ActiveBackupPlayerType), 1);
            candidatePlayerTypes.unshift(streamInfo.ActiveBackupPlayerType);
        }

        const adProcessingStart = Date.now();
        for (let i = 0; i < candidatePlayerTypes.length; i++) {
            // Общий лимит времени: плеер ждёт плейлист ~10 c, укладываемся в 6 c
            if (i > 0 && Date.now() - adProcessingStart > 6000) {
                console.warn('[VAFT] Лимит времени на поиск резервного потока исчерпан, использую запасной вариант');
                break;
            }
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
            }, 3000);

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
        const rootNode = pageDoc.querySelector('#root');
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

            if ((player.isPaused && player.isPaused()) || userManuallyPaused) {
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
                const currentMuted = pageWindow.localStorage.getItem(lsKeyMuted);
                const currentVolume = pageWindow.localStorage.getItem(lsKeyVolume);

                if (player?.core?.state) {
                    pageWindow.localStorage.setItem(lsKeyMuted, JSON.stringify({ default: player.core.state.muted }));
                    pageWindow.localStorage.setItem(lsKeyVolume, player.core.state.volume);
                }
                pageWindow.localStorage.setItem(lsKeyQuality, '{"default":"chunked"}');

                playerNode.setPlayerActive(false);
                setTimeout(() => {
                    try {
                        playerNode.setPlayerActive(true);
                    } finally {
                        if (currentMuted !== null) pageWindow.localStorage.setItem(lsKeyMuted, currentMuted);
                        if (currentVolume !== null) pageWindow.localStorage.setItem(lsKeyVolume, currentVolume);
                    }
                }, 150);
            }
        } catch (err) {
            console.warn('[VAFT] Ошибка выполнения задачи плеера:', err);
        }
    }

    function updateAdBlockBanner(show, isMidroll) {
        try {
            let banner = pageDoc.getElementById('vaft-adblock-banner');
            if (!show) {
                if (banner) {
                    banner.style.display = 'none';
                }
                return;
            }
            if (!banner) {
                const playerContainer = pageDoc.querySelector('.video-player__overlay, [data-a-target="video-player"]');
                if (!playerContainer) return;
                banner = pageDoc.createElement('div');
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

            const isShowingAd = isAdBannerShown();
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
                if (!player || (player.isPaused && player.isPaused()) || userManuallyPaused) {
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
                    pageDoc.querySelector('.tw-loading-spinner')
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

    declareOptions(pageWindow);

    if (pageWindow.DisableBackgroundDownscale) {
        setupAntiDownscaleAndVisibilityOverride();
    }

    if (isWorkerDoubleHooked(null, 'twitch')) {
        console.warn('[VAFT] Обнаружен другой блокировщик рекламы Twitch (Worker уже перехвачен). Пропуск запуска Worker-хука во избежание поломки плеера.');
    } else {
        pageWindow.reloadTwitchPlayer = doTwitchPlayerTask;
        hookWindowWorker();
        hookFetchForHeaders();
        if (pageDoc.readyState === 'loading') {
            pageDoc.addEventListener('DOMContentLoaded', setupBufferingMonitor);
        } else {
            setupBufferingMonitor();
        }
    }
})();
