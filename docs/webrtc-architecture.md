# WebRTC-соединения в Forta Chat

Подробное техническое описание архитектуры, реализации и потоков данных WebRTC-соединений в приложении.

## Содержание

1. [Общая архитектура](#общая-архитектура)
2. [Файловая структура](#файловая-структура)
3. [Жизненный цикл звонка](#жизненный-цикл-звонка)
4. [Сигналинг через Matrix](#сигналинг-через-matrix)
5. [ICE и TURN/STUN](#ice-и-turnstun)
6. [Управление медиа-потоками](#управление-медиа-потоками)
7. [Управление состоянием](#управление-состоянием)
8. [Обработка ошибок и переподключения](#обработка-ошибок-и-переподключения)
9. [Примеры кода](#примеры-кода)
10. [Сильные стороны](#сильные-стороны)
11. [Слабые стороны и ограничения](#слабые-стороны-и-ограничения)
12. [Диаграммы потоков данных](#диаграммы-потоков-данных)

---

## Общая архитектура

Приложение использует двухуровневую архитектуру для WebRTC-звонков:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  UI Layer (Vue 3 + Composition API)                                         │
│  ┌─────────────┐  ┌───────────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │ ChatWindow  │  │ IncomingCallModal │  │ CallWindow  │  │ CallControls │ │
│  │  (кнопки    │  │   (входящий       │  │  (основной  │  │  (микрофон,  │ │
│  │   звонка)   │  │    звонок)        │  │    UI)      │  │   камера)    │ │
│  └──────┬──────┘  └────────┬──────────┘  └──────┬──────┘  └──────┬───────┘ │
│         │                  │                    │                │         │
│         └──────────────────┴────────────────────┴────────────────┘         │
│                                    │                                        │
├────────────────────────────────────┼────────────────────────────────────────┤
│  Service Layer                     ▼                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        call-service.ts                               │   │
│  │  startCall(), handleIncomingCall(), answerCall(), hangup(),          │   │
│  │  toggleMute(), toggleCamera(), toggleScreenShare(),                  │   │
│  │  setAudioDevice(), setVideoDevice()                                  │   │
│  └──────────────────────────────────┬──────────────────────────────────┘   │
│                                     │                                       │
├─────────────────────────────────────┼───────────────────────────────────────┤
│  State Layer (Pinia)                ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                         call-store.ts                                │   │
│  │  activeCall, matrixCall, localStream, remoteStream,                  │   │
│  │  audioMuted, videoMuted, screenSharing, callTimer, history           │   │
│  └──────────────────────────────────┬──────────────────────────────────┘   │
│                                     │                                       │
├─────────────────────────────────────┼───────────────────────────────────────┤
│  SDK Layer (matrix-js-sdk-bastyon)  ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │   MatrixCall (call.ts)        │   CallEventHandler                   │   │
│  │   RTCPeerConnection           │   m.call.* event handling            │   │
│  │   SDP offer/answer            │   ICE candidate buffering            │   │
│  │   MediaHandler                │   Call.incoming emit                 │   │
│  └──────────────────────────────────┬──────────────────────────────────┘   │
│                                     │                                       │
├─────────────────────────────────────┼───────────────────────────────────────┤
│  Transport Layer                    ▼                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     Matrix Server (Synapse)                          │   │
│  │   Room events: m.call.invite, m.call.answer, m.call.candidates,      │   │
│  │                m.call.hangup, m.call.reject                          │   │
│  │   To-device events (for encrypted rooms / group calls)               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Файловая структура

### Application Layer

| Путь | Назначение |
|------|------------|
| `src/features/video-calls/model/call-service.ts` | Главный сервис звонков: оркестрация, интеграция с SDK |
| `src/features/video-calls/model/use-media-devices.ts` | Composable для перечисления устройств (камера, микрофон, динамик) |
| `src/features/video-calls/model/call-tab-lock.ts` | Блокировка звонков между вкладками через BroadcastChannel |
| `src/features/video-calls/model/call-sounds.ts` | Звуки звонков (рингтон, гудок, конец) через Web Audio API |
| `src/features/video-calls/ui/CallWindow.vue` | Основной UI звонка, раскладка видео |
| `src/features/video-calls/ui/CallControls.vue` | Кнопки управления: mute, камера, screen share, устройства |
| `src/features/video-calls/ui/IncomingCallModal.vue` | Модалка входящего звонка |
| `src/features/video-calls/ui/VideoTile.vue` | Компонент видео-плитки |
| `src/features/video-calls/ui/CallStatusBar.vue` | Мини-бар статуса звонка |
| `src/entities/call/model/call-store.ts` | Pinia store для состояния звонка |
| `src/entities/call/model/types.ts` | TypeScript типы: CallInfo, CallStatus, CallHistoryEntry |
| `src/entities/matrix/model/matrix-client.ts` | Matrix клиент с настройками VoIP и обработкой `Call.incoming` |

### SDK Layer (node_modules/matrix-js-sdk-bastyon)

| Путь | Назначение |
|------|------------|
| `src/webrtc/call.ts` | MatrixCall класс: RTCPeerConnection, offer/answer, ICE, сигналинг |
| `src/webrtc/callEventHandler.ts` | Обработка m.call.* событий, эмит `Call.incoming` |
| `src/webrtc/callFeed.ts` | CallFeed: обёртка над MediaStream для local/remote потоков |
| `src/webrtc/mediaHandler.ts` | getUserMedia, выбор устройств |
| `src/client.ts` | getTurnServers, iceCandidatePoolSize, checkTurnServers |

---

## Жизненный цикл звонка

### Исходящий звонок (Outgoing)

```
Пользователь нажимает кнопку звонка в ChatWindow
                    │
                    ▼
        useCallService().startCall(roomId, type)
                    │
                    ▼
    ┌───────────────┴───────────────┐
    │  1. checkOtherTabHasCall()    │ ← Проверка через BroadcastChannel
    │  2. createNewMatrixCall()     │ ← SDK создаёт MatrixCall
    │  3. Создание CallInfo         │
    │  4. callStore.setActiveCall() │
    │  5. wireCallEvents()          │ ← Подписка на события SDK
    │  6. hintStoredDevices()       │ ← Намёк на сохранённые устройства
    │  7. playDialtone()            │
    └───────────────┬───────────────┘
                    │
                    ▼
    call.placeVoiceCall() / call.placeVideoCall()
                    │
                    ▼
    SDK отправляет m.call.invite в комнату Matrix
                    │
                    ▼
    Состояние: Ringing → Connecting → Connected
```

### Входящий звонок (Incoming)

```
Matrix сервер доставляет m.call.invite
                    │
                    ▼
    SDK CallEventHandler обрабатывает событие
                    │
                    ▼
    client.emit("Call.incoming", matrixCall)
                    │
                    ▼
    matrix-client.ts: onIncomingCall callback
                    │
                    ▼
    stores.ts → handleIncomingCall(matrixCall)
                    │
                    ▼
    ┌───────────────┴───────────────┐
    │  1. Проверка: уже в звонке?   │
    │  2. checkOtherTabHasCall()    │
    │  3. Создание CallInfo         │
    │  4. wireCallEvents()          │
    │  5. playRingtone()            │
    │  6. Таймер 30с авто-reject    │
    └───────────────┬───────────────┘
                    │
                    ▼
    Показ IncomingCallModal
                    │
         ┌──────────┴──────────┐
         │                     │
         ▼                     ▼
     Accept                 Decline
         │                     │
         ▼                     ▼
   answerCall()          rejectCall()
         │                     │
         ▼                     ▼
   call.answer()         call.reject()
```

### Завершение звонка (Hangup)

```
    hangup() вызывается
            │
            ▼
┌───────────┴───────────┐
│ 1. clearIncomingTimeout()
│ 2. stopAllSounds()
│ 3. call.hangup(CallErrorCode.UserHangup, false)
│ 4. scheduleClearCall(3000) ← fallback очистка
└───────────┬───────────┘
            │
            ▼
    SDK отправляет m.call.hangup
            │
            ▼
    CallEvent.State → Ended
            │
            ▼
    unwireCallEvents()
            │
            ▼
    callStore.addHistoryEntry()
            │
            ▼
    callStore.scheduleClearCall(1500)
```

---

## Сигналинг через Matrix

WebRTC требует обмена сигнальными данными (SDP, ICE candidates) между участниками. В этом приложении сигналинг реализован через Matrix протокол.

### Matrix Call Events

| Событие | Направление | Содержимое |
|---------|-------------|------------|
| `m.call.invite` | Caller → Callee | SDP offer, lifetime, call_id, party_id |
| `m.call.answer` | Callee → Caller | SDP answer, call_id, party_id |
| `m.call.candidates` | Оба направления | Массив ICE candidates |
| `m.call.hangup` | Оба направления | reason, call_id |
| `m.call.reject` | Callee → Caller | Отклонение без ответа |

### Поток сигналинга

```
    Caller (A)                     Matrix Server                    Callee (B)
        │                               │                               │
        │  m.call.invite (SDP offer)    │                               │
        ├──────────────────────────────►│                               │
        │                               │  m.call.invite                │
        │                               ├──────────────────────────────►│
        │                               │                               │
        │                               │  m.call.answer (SDP answer)   │
        │                               │◄──────────────────────────────┤
        │  m.call.answer                │                               │
        │◄──────────────────────────────┤                               │
        │                               │                               │
        │  m.call.candidates            │                               │
        ├──────────────────────────────►│──────────────────────────────►│
        │                               │                               │
        │                               │  m.call.candidates            │
        │◄──────────────────────────────│◄──────────────────────────────┤
        │                               │                               │
        │       ═══════════ ICE Connectivity Established ═══════════    │
        │                               │                               │
        │◄═══════════════════ P2P Media Stream ═══════════════════════►│
```

### Код: обработка событий в SDK (callEventHandler.ts)

```typescript
// SDK буферизует события и обрабатывает их после синхронизации
private async evaluateEventBuffer(eventBuffer: MatrixEvent[]): Promise<void> {
    await Promise.all(eventBuffer.map((event) => this.client.decryptEventIfNeeded(event)));

    const callEvents = eventBuffer.filter((event) => {
        const eventType = event.getType();
        return eventType.startsWith("m.call.") || eventType.startsWith("org.matrix.call.");
    });

    // Помечаем звонки, которые уже отвечены/завершены
    const ignoreCallIds = new Set<string>();
    for (const event of callEvents) {
        if (eventType === EventType.CallAnswer || eventType === EventType.CallHangup) {
            ignoreCallIds.add(event.getContent().call_id);
        }
    }

    // Обрабатываем события в порядке получения
    for (const event of callEvents) {
        // m.call.invite → создаём MatrixCall и эмитим Call.incoming
        // m.call.candidates → добавляем ICE candidates
        // m.call.answer → устанавливаем remote description
        // m.call.hangup → завершаем звонок
    }
}
```

---

## ICE и TURN/STUN

### Конфигурация клиента (matrix-client.ts)

```typescript
const userClientData = {
    baseUrl: this.baseUrl,
    userId: userData.user_id,
    accessToken: userData.access_token,
    // WebRTC настройки
    iceCandidatePoolSize: 20,        // Предварительный сбор ICE candidates
    fallbackICEServerAllowed: true,  // Разрешить fallback STUN сервер
    disableVoip: false,              // Включить VoIP обработчик
};
```

### Создание RTCPeerConnection (SDK call.ts)

```typescript
// В конструкторе MatrixCall
this.turnServers = opts.turnServers || [];

// Если TURN серверов нет, используем fallback
if (this.turnServers.length === 0 && this.client.isFallbackICEServerAllowed()) {
    this.turnServers.push({
        urls: [FALLBACK_ICE_SERVER], // "stun:turn.matrix.org"
    });
}

// Создание peer connection
private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({
        iceTransportPolicy: this.forceTURN ? "relay" : undefined,
        iceServers: this.turnServers.length ? this.turnServers : undefined,
        iceCandidatePoolSize: this.client.iceCandidatePoolSize,
        bundlePolicy: "max-bundle",
    });
    
    // Обработчики событий
    pc.onicecandidate = this.gotLocalIceCandidate;
    pc.oniceconnectionstatechange = this.onIceConnectionStateChanged;
    pc.onicegatheringstatechange = this.onIceGatheringStateChange;
    pc.ontrack = this.onTrack;
    
    return pc;
}
```

### Обработка ICE Candidates

```typescript
// Локальные кандидаты — батчим для отправки
private gotLocalIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
    if (event.candidate) {
        this.queueCandidate(event.candidate);
    }
    // null означает конец сбора кандидатов
    if (event.candidate === null) {
        this.candidatesEnded = true;
    }
};

// Отправка кандидатов батчами
private queueCandidate(candidate: RTCIceCandidate): void {
    this.candidateSendQueue.push(candidate);
    
    // Отложенная отправка для батчинга
    if (!this.candidateSendTimeout) {
        this.candidateSendTimeout = setTimeout(() => {
            this.sendCandidateQueue();
        }, 100);
    }
}

// Получение удалённых кандидатов
public onRemoteIceCandidatesReceived(event: MatrixEvent): void {
    const content = event.getContent<MCallCandidates>();
    
    // Если оппонент ещё не выбран (multi-device), буферизуем по party_id
    if (this.opponentPartyId === undefined) {
        const dominated = [...this.remoteCandidateBuffer.keys()]
            .find(odid => odid !== odid && odid < content.party_id);
        // ... буферизация
    }
    
    // Добавляем кандидаты
    await this.addIceCandidates(content.candidates);
}

private async addIceCandidates(candidates: RTCIceCandidateInit[]): Promise<void> {
    for (const candidate of candidates) {
        await this.peerConn.addIceCandidate(candidate);
    }
}
```

### Таймауты и переподключения

```typescript
// Константы (SDK)
const ICE_DISCONNECTED_TIMEOUT = 30 * 1000; // 30 секунд до завершения
const ICE_RECONNECTING_TIMEOUT = 2 * 1000;  // 2 секунды до попытки ICE restart

// Обработка состояния ICE
private onIceConnectionStateChanged = (): void => {
    switch (this.peerConn.iceConnectionState) {
        case "connected":
        case "completed":
            this.clearIceDisconnectedTimeout();
            break;
            
        case "disconnected":
            // Через 2с пробуем ICE restart
            this.iceReconnectionTimeOut = setTimeout(() => {
                this.restartIce();
            }, ICE_RECONNECTING_TIMEOUT);
            
            // Через 30с если не восстановилось — завершаем
            this.iceDisconnectedTimeout = setTimeout(() => {
                this.hangup(CallErrorCode.IceFailed, false);
            }, ICE_DISCONNECTED_TIMEOUT);
            break;
            
        case "failed":
            // Пробуем ICE restart, если не получится — завершаем
            if (this.peerConn.restartIce) {
                this.restartIce();
            } else {
                this.hangup(CallErrorCode.IceFailed, false);
            }
            break;
    }
};
```

---

## Управление медиа-потоками

### Типы потоков

| Поток | Источник | Назначение |
|-------|----------|------------|
| `localUsermediaStream` | Локальная камера/микрофон | Отправляется удалённому участнику |
| `remoteUsermediaStream` | Удалённый участник | Отображается в UI + воспроизводится аудио |
| `localScreensharingStream` | Локальный screen share | Отправляется удалённому участнику |
| `remoteScreensharingStream` | Удалённый screen share | Отображается в UI |

### Синхронизация потоков с store (call-service.ts)

```typescript
function updateFeeds(call: MatrixCall) {
    const callStore = useCallStore();
    try {
        // Локальная камера (всегда usermedia, не screenshare)
        callStore.setLocalStream(call.localUsermediaStream ?? null);
        
        // Локальный screen share
        callStore.setLocalScreenStream(call.localScreensharingStream ?? null);
        
        // Удалённая камера (включает аудио трек)
        callStore.setRemoteStream(call.remoteUsermediaStream ?? null);
        
        // Удалённый screen share
        callStore.setRemoteScreenStream(call.remoteScreensharingStream ?? null);
        callStore.remoteScreenSharing = !!call.remoteScreensharingStream;
        
        // Синхронизация состояния mute удалённого видео
        syncRemoteVideoMuted(call);
    } catch (e) {
        console.warn("[call-service] updateFeeds error:", e);
    }
}
```

### Переключение устройств во время звонка

SDK использует `{ideal: deviceId}` constraint, который браузер может проигнорировать. Приложение реализует собственный механизм с `{exact: deviceId}`:

```typescript
async function setAudioDevice(deviceId: string) {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    // 1. Получаем новый трек с exact constraint
    const newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
    });
    const newTrack = newStream.getAudioTracks()[0];

    // 2. Заменяем трек на WebRTC sender
    const pc: RTCPeerConnection = (call as any).peerConn;
    if (pc) {
        const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (audioSender) {
            await audioSender.replaceTrack(newTrack);
        }
    }

    // 3. Заменяем трек в локальном MediaStream (для UI)
    const localStream = call.localUsermediaStream;
    if (localStream) {
        const oldTrack = localStream.getAudioTracks()[0];
        if (oldTrack) {
            localStream.removeTrack(oldTrack);
            oldTrack.stop();
        }
        localStream.addTrack(newTrack);
    }

    // 4. Синхронизируем с mediaHandler SDK
    const client = getClient();
    const mediaHandler = client?.getMediaHandler?.();
    if (mediaHandler?.restoreMediaSettings) {
        const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
        mediaHandler.restoreMediaSettings(deviceId, savedVideo);
    }

    updateFeeds(call);
}
```

### Выбор аудио-выхода (динамика)

```typescript
// CallWindow.vue
function applyAudioOutput(el: HTMLVideoElement | null, deviceId: string) {
    if (!el || !deviceId) return;
    // setSinkId позволяет направить аудио на конкретное устройство
    if (typeof (el as any).setSinkId === "function") {
        (el as any).setSinkId(deviceId).catch((e: unknown) => {
            console.warn("[CallWindow] setSinkId error:", e);
        });
    }
}

// Применяется к скрытому <video> элементу с remoteStream
watch(
    () => callStore.audioOutputId,
    (id) => applyAudioOutput(remoteAudioRef.value, id),
    { flush: "post" },
);
```

### Screen Sharing

```typescript
async function toggleScreenShare() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    const wasEnabled = callStore.screenSharing;
    
    // SDK сам вызывает getDisplayMedia и управляет transceivers
    const newState = await call.setScreensharingEnabled(!wasEnabled);
    
    callStore.screenSharing = newState;
    updateFeeds(call);
}
```

---

## Управление состоянием

### CallStatus (types.ts)

```typescript
export enum CallStatus {
    idle = "idle",           // Нет активного звонка
    ringing = "ringing",     // Исходящий: ждём ответа
    incoming = "incoming",   // Входящий: показываем модалку
    connecting = "connecting", // Установка соединения
    connected = "connected", // Соединение установлено
    ended = "ended",         // Звонок завершён
    failed = "failed",       // Ошибка
}
```

### CallInfo

```typescript
export interface CallInfo {
    callId: string;          // Уникальный ID звонка
    roomId: string;          // ID комнаты Matrix
    peerId: string;          // Matrix ID собеседника
    peerAddress: string;     // Bastyon адрес собеседника
    peerName: string;        // Имя собеседника
    type: "voice" | "video"; // Тип звонка
    direction: "outgoing" | "incoming";
    status: CallStatus;
    startedAt: number | null; // Timestamp начала
    endedAt: number | null;
}
```

### Call Store (Pinia)

```typescript
export const useCallStore = defineStore("call", () => {
    // Основное состояние
    const activeCall = ref<CallInfo | null>(null);
    const matrixCall = shallowRef<any>(null);  // SDK объект звонка
    
    // Медиа потоки
    const localStream = shallowRef<MediaStream | null>(null);
    const remoteStream = shallowRef<MediaStream | null>(null);
    const localScreenStream = shallowRef<MediaStream | null>(null);
    const remoteScreenStream = shallowRef<MediaStream | null>(null);
    
    // Состояние mute
    const audioMuted = ref(false);
    const videoMuted = ref(false);
    const remoteVideoMuted = ref(false);
    
    // Screen sharing
    const screenSharing = ref(false);
    const remoteScreenSharing = ref(false);
    
    // UI состояние
    const pinnedTile = ref<string | null>(null);
    const callTimer = ref(0);
    const audioOutputId = ref(localStorage.getItem("bastyon_call_output_device") ?? "");
    
    // История звонков
    const history = ref<CallHistoryEntry[]>([]);
    
    // Computed
    const isInCall = computed(() =>
        activeCall.value !== null &&
        activeCall.value.status !== CallStatus.idle &&
        activeCall.value.status !== CallStatus.ended &&
        activeCall.value.status !== CallStatus.failed
    );
    
    // ... методы
});
```

### Маппинг состояний SDK → App

```typescript
function mapSDKState(state: SDKCallState, direction: "outgoing" | "incoming"): CallStatus {
    switch (state) {
        case SDKCallState.Ringing:
            // Для исходящего: ringing, для входящего: incoming
            return direction === "outgoing" ? CallStatus.ringing : CallStatus.incoming;
            
        case SDKCallState.Connecting:
        case SDKCallState.CreateOffer:
        case SDKCallState.CreateAnswer:
        case SDKCallState.InviteSent:
        case SDKCallState.WaitLocalMedia:
            return CallStatus.connecting;
            
        case SDKCallState.Connected:
            return CallStatus.connected;
            
        case SDKCallState.Ended:
            return CallStatus.ended;
            
        default:
            return CallStatus.connecting;
    }
}
```

---

## Обработка ошибок и переподключения

### Уровень приложения (call-service.ts)

```typescript
// Ошибка при размещении звонка
try {
    if (type === "video") {
        await call.placeVideoCall();
    } else {
        await call.placeVoiceCall();
    }
} catch (e) {
    console.error("[call-service] Failed to place call:", e);
    stopAllSounds();
    unwireCallEvents(call);
    callStore.updateStatus(CallStatus.failed);
    callStore.scheduleClearCall(2000);
}

// Обработка ошибок SDK
const onError = ((error: unknown) => {
    console.error("[call-service] call error:", error);
    stopAllSounds();
    clearIncomingTimeout();
    unwireCallEvents(call);
    callStore.updateStatus(CallStatus.failed);
    
    // Записываем в историю
    if (callStore.activeCall) {
        callStore.addHistoryEntry({
            id: callStore.activeCall.callId,
            roomId: callStore.activeCall.roomId,
            peerId: callStore.activeCall.peerId,
            peerName: callStore.activeCall.peerName,
            type: callStore.activeCall.type,
            direction: callStore.activeCall.direction,
            status: "failed",
            startedAt: callStore.activeCall.startedAt ?? Date.now(),
            duration: callStore.callTimer,
        });
    }
    callStore.scheduleClearCall(2000);
}) as CallEventHandlerMap[CallEvent.Error];
```

### Уровень SDK (call.ts)

```typescript
// ICE Failed
case "failed":
    if (this.peerConn.restartIce) {
        logger.info(`Call ${this.callId} ICE failed, attempting restart`);
        this.restartIce();
    } else {
        this.hangup(CallErrorCode.IceFailed, false);
    }
    break;

// ICE Disconnected с таймаутами
case "disconnected":
    // Попытка ICE restart через 2 секунды
    this.iceReconnectionTimeOut = setTimeout(() => {
        this.restartIce();
    }, ICE_RECONNECTING_TIMEOUT);
    
    // Завершение через 30 секунд если не восстановилось
    this.iceDisconnectedTimeout = setTimeout(() => {
        this.hangup(CallErrorCode.IceFailed, false);
    }, ICE_DISCONNECTED_TIMEOUT);
    break;
```

### Fallback очистка

```typescript
// hangup() — если SDK не эмитит Ended, очищаем принудительно
function hangup() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    try {
        call.hangup(CallErrorCode.UserHangup, false);
    } catch (e) {
        console.warn("[call-service] hangup error:", e);
    }

    // Fallback cleanup если SDK не вызовет Ended
    callStore.scheduleClearCall(3000);
}
```

---

## Примеры кода

### Пример 1: Начало исходящего звонка

```typescript
// В ChatWindow.vue
const { startCallFromHeader } = useChatCall();

async function startCallFromHeader(type: "voice" | "video") {
    const chatStore = useChatStore();
    if (!chatStore.activeRoomId) return;
    
    const callService = useCallService();
    await callService.startCall(chatStore.activeRoomId, type);
}
```

```typescript
// call-service.ts - startCall
async function startCall(roomId: string, type: CallType) {
    // Проверки
    if (callStore.isInCall) {
        console.warn("[call-service] Already in a call");
        return;
    }

    const otherTabActive = await checkOtherTabHasCall();
    if (otherTabActive) {
        console.warn("[call-service] Another tab already has an active call");
        return;
    }

    // Отмена отложенной очистки предыдущего звонка
    callStore.cancelScheduledClear();

    const client = matrixService.client;
    if (!client) {
        console.error("[call-service] No Matrix client");
        return;
    }

    // Создание объекта звонка через SDK
    const call = createNewMatrixCall(client, roomId);
    if (!call) {
        console.error("[call-service] createNewMatrixCall returned null");
        return;
    }

    // Получение информации о собеседнике
    const room = client.getRoom(roomId);
    const myUserId = matrixService.getUserId();
    const members = room?.getJoinedMembers() ?? [];
    const peer = members.find((m) => m.userId !== myUserId);
    const { peerAddress, peerName } = resolvePeerInfo(peer?.userId ?? "");

    // Создание CallInfo
    const callInfo: CallInfo = {
        callId: call.callId,
        roomId,
        peerId: peer?.userId ?? "",
        peerAddress,
        peerName,
        type,
        direction: "outgoing",
        status: CallStatus.ringing,
        startedAt: null,
        endedAt: null,
    };

    // Обновление store
    callStore.setActiveCall(callInfo);
    callStore.setMatrixCall(call);
    callStore.videoMuted = type === "voice";

    // Подписка на события
    wireCallEvents(call, "outgoing");

    // Звуковые эффекты
    playDialtone();

    // Намёк на сохранённые устройства
    hintStoredDevices(client);

    // Размещение звонка
    try {
        if (type === "video") {
            await call.placeVideoCall();
        } else {
            await call.placeVoiceCall();
        }
        console.log("[call-service] Call placed successfully");
    } catch (e) {
        console.error("[call-service] Failed to place call:", e);
        // Обработка ошибки...
    }
}
```

### Пример 2: Обработка входящего звонка

```typescript
// matrix-client.ts
this.client.on("Call.incoming" as string, (call: unknown) => {
    this.onIncomingCall?.(call);
});

// stores.ts
matrixService.setHandlers({
    onIncomingCall: async (call: unknown) => {
        const { useCallService } = await import("@/features/video-calls/model/call-service");
        const callService = useCallService();
        callService.handleIncomingCall(call as MatrixCall);
    },
});

// call-service.ts
async function handleIncomingCall(matrixCall: MatrixCall) {
    console.log("[call-service] Incoming call, callId=%s", matrixCall.callId);

    // Отклоняем если уже в звонке
    if (callStore.isInCall) {
        matrixCall.reject();
        return;
    }

    // Проверяем другие вкладки
    const otherTabActive = await checkOtherTabHasCall();
    if (otherTabActive) {
        matrixCall.reject();
        return;
    }

    // Получение информации о звонящем
    const peerId = matrixCall.getOpponentMember()?.userId ?? "";
    const { peerAddress, peerName } = resolvePeerInfo(peerId);
    const isVideo = matrixCall.type === "video";

    // Создание CallInfo
    const callInfo: CallInfo = {
        callId: matrixCall.callId,
        roomId: matrixCall.roomId,
        peerId,
        peerAddress,
        peerName,
        type: isVideo ? "video" : "voice",
        direction: "incoming",
        status: CallStatus.incoming,
        startedAt: null,
        endedAt: null,
    };

    callStore.setActiveCall(callInfo);
    callStore.setMatrixCall(matrixCall);
    callStore.videoMuted = !isVideo;
    wireCallEvents(matrixCall, "incoming");

    playRingtone();

    // Авто-отклонение через 30 секунд
    incomingTimeoutId = setTimeout(() => {
        if (callStore.activeCall?.status === CallStatus.incoming) {
            rejectCall();
        }
    }, 30_000);
}
```

### Пример 3: Toggle камеры с восстановлением устройства

```typescript
async function toggleCamera() {
    const call = callStore.matrixCall as MatrixCall | null;
    if (!call) return;

    // Защита от повторных вызовов
    if (toggleCameraLock) {
        console.warn("[call-service] toggleCamera already in progress");
        return;
    }
    toggleCameraLock = true;

    try {
        const wantMuted = !callStore.videoMuted;
        console.log("[call-service] toggleCamera → %s", wantMuted ? "off" : "on");

        // SDK управляет track.enabled и может запросить новый stream
        await call.setLocalVideoMuted(wantMuted);
        callStore.videoMuted = wantMuted;

        // Апгрейд voice → video если включаем камеру
        if (!wantMuted && callStore.activeCall?.type === "voice") {
            callStore.setActiveCall({ ...callStore.activeCall, type: "video" });
        }
        updateFeeds(call);

        // При включении камеры SDK может выбрать не то устройство
        // Восстанавливаем сохранённое
        if (!wantMuted) {
            const savedVideo = localStorage.getItem("bastyon_call_video_device") ?? "";
            if (savedVideo) {
                const newTrack = call.localUsermediaStream?.getVideoTracks()[0];
                const currentId = newTrack?.getSettings()?.deviceId ?? "";
                if (currentId && currentId !== savedVideo) {
                    console.log("[call-service] toggleCamera: re-applying saved video device");
                    await setVideoDevice(savedVideo);
                }
            }
        }
    } finally {
        toggleCameraLock = false;
    }
}
```

---

## Сильные стороны

### 1. Чёткое разделение ответственности
- UI компоненты отвечают только за отображение
- call-service инкапсулирует бизнес-логику
- SDK обеспечивает низкоуровневую работу с WebRTC

### 2. Реактивное состояние через Pinia
- Все изменения состояния автоматически отражаются в UI
- `shallowRef` для MediaStream позволяет избежать глубокой реактивности
- `triggerRef` обеспечивает обновление при замене треков внутри того же stream

### 3. Надёжная синхронизация устройств
- Сохранение выбранных устройств в localStorage
- Восстановление устройств при начале звонка и при включении камеры
- Использование `{exact: deviceId}` вместо `{ideal: deviceId}` для гарантированного выбора

### 4. Защита от race conditions
- Блокировка между вкладками через BroadcastChannel
- Lock на toggle операции (toggleCameraLock)
- Fallback очистка при незавершённых звонках

### 5. Graceful degradation
- Fallback STUN сервер если TURN недоступен
- Попытки ICE restart при проблемах соединения
- Автоматическое downgrade video → voice при ошибке камеры

### 6. Хорошая интеграция с Matrix протоколом
- Сигналинг через стандартные Matrix события
- Поддержка буферизации событий для корректного порядка
- Обработка glare (одновременные звонки)

---

## Слабые стороны и ограничения

### 1. Отсутствие собственных TURN/STUN серверов

**Проблема**: Приложение зависит от TURN серверов homeserver'а (из `.well-known`) и fallback `stun:turn.matrix.org`.

**Последствия**:
- За симметричным NAT звонки могут не устанавливаться
- Зависимость от внешней инфраструктуры Matrix.org

**Решение**: Развернуть собственные TURN серверы (coturn) и передавать их в опциях клиента:
```typescript
turnServers: [
    {
        urls: ["turn:turn.bastyon.com:3478"],
        username: "user",
        credential: "password",
    },
    {
        urls: ["stun:stun.bastyon.com:3478"],
    },
]
```

### 2. Race condition в call-tab-lock

**Проблема**: Проверка `checkOtherTabHasCall()` использует 300ms timeout.

**Последствия**: При быстрых действиях в нескольких вкладках возможны дубликаты звонков.

**Код проблемы**:
```typescript
export function checkOtherTabHasCall(): Promise<boolean> {
    return new Promise((resolve) => {
        // ... отправка сообщения
        setTimeout(() => {
            if (!responded) {
                resolve(false); // 300ms — может быть недостаточно
            }
        }, 300);
    });
}
```

### 3. Отсутствие UI для качества связи

**Проблема**: SDK имеет API для получения статистики соединения, но UI их не показывает.

**Код SDK (доступно, но не используется)**:
```typescript
// SDK предоставляет
public async getCurrentCallStats(): Promise<any[] | undefined> {
    const statsReport = await this.peerConn.getStats();
    // ...
}
```

**Решение**: Добавить индикатор качества связи в CallWindow.vue.

### 4. Зависимость от Ended event SDK

**Проблема**: При hangup() мы надеемся что SDK вызовет Ended, иначе используем fallback timeout.

**Код**:
```typescript
function hangup() {
    call.hangup(CallErrorCode.UserHangup, false);
    // Fallback если SDK не вызовет Ended
    callStore.scheduleClearCall(3000);
}
```

### 5. Непоследовательная история звонков

**Проблема**: История зависит от событий SDK и может содержать неполные записи при ошибках.

### 6. Отсутствие групповых звонков

**Проблема**: SDK поддерживает GroupCall, но приложение реализует только 1:1 звонки.

### 7. Неиспользуемый media-constraints.ts

**Проблема**: Файл `src/entities/media/lib/media-constraints.ts` определяет constraints, но call-service их не использует — SDK сам управляет constraints.

---

## Диаграммы потоков данных

### Поток данных при исходящем звонке

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           ИСХОДЯЩИЙ ЗВОНОК                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User clicks "Call"                                                         │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────────┐                                                        │
│  │  ChatWindow.vue │                                                        │
│  └────────┬────────┘                                                        │
│           │ startCallFromHeader(type)                                       │
│           ▼                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      call-service.ts                                 │   │
│  │  ┌────────────────────────────────────────────────────────────────┐ │   │
│  │  │ 1. checkOtherTabHasCall() ─────► BroadcastChannel              │ │   │
│  │  │ 2. createNewMatrixCall(client, roomId) ─────► SDK              │ │   │
│  │  │ 3. Build CallInfo { callId, roomId, peerId, ... }              │ │   │
│  │  │ 4. callStore.setActiveCall(callInfo)                           │ │   │
│  │  │ 5. callStore.setMatrixCall(matrixCall)                         │ │   │
│  │  │ 6. wireCallEvents(call, "outgoing")                            │ │   │
│  │  │ 7. hintStoredDevices(client)                                   │ │   │
│  │  │ 8. playDialtone()                                              │ │   │
│  │  │ 9. call.placeVoiceCall() / call.placeVideoCall()               │ │   │
│  │  └────────────────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────┬──────────────────────────────────┘   │
│                                     │                                       │
│           ┌─────────────────────────┼─────────────────────────┐             │
│           │                         │                         │             │
│           ▼                         ▼                         ▼             │
│  ┌────────────────┐      ┌────────────────┐       ┌────────────────┐       │
│  │   call-store   │      │  SDK MatrixCall │       │  Web Audio API │       │
│  │    (Pinia)     │      │                │       │   (sounds)     │       │
│  └───────┬────────┘      └───────┬────────┘       └────────────────┘       │
│          │                       │                                          │
│          │                       ▼                                          │
│          │              ┌────────────────┐                                  │
│          │              │ RTCPeerConnection                                 │
│          │              │ createOffer()  │                                  │
│          │              │ setLocalDescription()                             │
│          │              └───────┬────────┘                                  │
│          │                      │                                           │
│          │                      ▼                                           │
│          │              ┌────────────────┐                                  │
│          │              │ Matrix Client  │                                  │
│          │              │ sendEvent()    │                                  │
│          │              │ m.call.invite  │                                  │
│          │              └───────┬────────┘                                  │
│          │                      │                                           │
│          │                      ▼                                           │
│          │              ┌────────────────┐                                  │
│          │              │ Matrix Server  │──────────► Remote Peer           │
│          │              │   (Synapse)    │                                  │
│          │              └────────────────┘                                  │
│          │                                                                  │
│          ▼                                                                  │
│  ┌────────────────┐                                                         │
│  │  CallWindow.vue │◄──── watch(callStore.activeCall)                       │
│  │  (shows UI)     │                                                        │
│  └────────────────┘                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Поток событий SDK

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        СОБЫТИЯ SDK → ПРИЛОЖЕНИЕ                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SDK MatrixCall                                                             │
│       │                                                                     │
│       │ emit(CallEvent.State, newState, oldState)                          │
│       │ emit(CallEvent.FeedsChanged, feeds)                                │
│       │ emit(CallEvent.Hangup)                                             │
│       │ emit(CallEvent.Error, error)                                       │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    wireCallEvents() handlers                         │   │
│  │  ┌────────────────────────────────────────────────────────────────┐ │   │
│  │  │ onState: (newState, oldState) => {                             │ │   │
│  │  │     const status = mapSDKState(newState, direction);           │ │   │
│  │  │     callStore.updateStatus(status);                            │ │   │
│  │  │                                                                │ │   │
│  │  │     if (status === CallStatus.connected) {                     │ │   │
│  │  │         stopAllSounds();                                       │ │   │
│  │  │         callStore.startTimer();                                │ │   │
│  │  │         updateFeeds(call);                                     │ │   │
│  │  │         applySavedDevicesExact(call);                          │ │   │
│  │  │     }                                                          │ │   │
│  │  │                                                                │ │   │
│  │  │     if (status === CallStatus.ended) {                         │ │   │
│  │  │         stopAllSounds();                                       │ │   │
│  │  │         callStore.stopTimer();                                 │ │   │
│  │  │         unwireCallEvents(call);                                │ │   │
│  │  │         callStore.addHistoryEntry(...);                        │ │   │
│  │  │         callStore.scheduleClearCall(1500);                     │ │   │
│  │  │     }                                                          │ │   │
│  │  │ }                                                              │ │   │
│  │  └────────────────────────────────────────────────────────────────┘ │   │
│  │  ┌────────────────────────────────────────────────────────────────┐ │   │
│  │  │ onFeeds: () => {                                               │ │   │
│  │  │     updateFeeds(call);                                         │ │   │
│  │  │ }                                                              │ │   │
│  │  └────────────────────────────────────────────────────────────────┘ │   │
│  │  ┌────────────────────────────────────────────────────────────────┐ │   │
│  │  │ onHangup: () => {                                              │ │   │
│  │  │     stopAllSounds();                                           │ │   │
│  │  │     clearIncomingTimeout();                                    │ │   │
│  │  │ }                                                              │ │   │
│  │  └────────────────────────────────────────────────────────────────┘ │   │
│  │  ┌────────────────────────────────────────────────────────────────┐ │   │
│  │  │ onError: (error) => {                                          │ │   │
│  │  │     stopAllSounds();                                           │ │   │
│  │  │     unwireCallEvents(call);                                    │ │   │
│  │  │     callStore.updateStatus(CallStatus.failed);                 │ │   │
│  │  │     callStore.addHistoryEntry({ status: "failed" });           │ │   │
│  │  │     callStore.scheduleClearCall(2000);                         │ │   │
│  │  │ }                                                              │ │   │
│  │  └────────────────────────────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Поток медиа-данных

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              МЕДИА ПОТОКИ                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  LOCAL DEVICE                              REMOTE DEVICE                    │
│  ┌─────────────────┐                      ┌─────────────────┐              │
│  │ 📹 Camera       │                      │ 📹 Camera       │              │
│  │ 🎤 Microphone   │                      │ 🎤 Microphone   │              │
│  │ 🖥️ Screen       │                      │ 🖥️ Screen       │              │
│  └────────┬────────┘                      └────────┬────────┘              │
│           │                                        │                        │
│           ▼                                        ▼                        │
│  ┌─────────────────┐                      ┌─────────────────┐              │
│  │ getUserMedia()  │                      │ getUserMedia()  │              │
│  │ getDisplayMedia()                      │ getDisplayMedia()              │
│  └────────┬────────┘                      └────────┬────────┘              │
│           │                                        │                        │
│           ▼                                        ▼                        │
│  ┌─────────────────┐                      ┌─────────────────┐              │
│  │ MediaStream     │                      │ MediaStream     │              │
│  │ (localUsermedia)│                      │ (localUsermedia)│              │
│  └────────┬────────┘                      └────────┬────────┘              │
│           │                                        │                        │
│           ▼                                        ▼                        │
│  ┌─────────────────┐                      ┌─────────────────┐              │
│  │ RTCPeerConnection                      │ RTCPeerConnection              │
│  │ ┌─────────────┐ │                      │ ┌─────────────┐ │              │
│  │ │ Audio Track ├─┼────── WebRTC ───────►│ │ Audio Track │ │              │
│  │ │ Video Track ├─┼────── WebRTC ───────►│ │ Video Track │ │              │
│  │ │ Screen Track├─┼────── WebRTC ───────►│ │ Screen Track│ │              │
│  │ └─────────────┘ │◄───── WebRTC ────────┼─┤             │ │              │
│  └────────┬────────┘                      └────────┬────────┘              │
│           │                                        │                        │
│           │ ontrack event                          │ ontrack event          │
│           ▼                                        ▼                        │
│  ┌─────────────────┐                      ┌─────────────────┐              │
│  │ remoteUsermedia │                      │ remoteUsermedia │              │
│  │ remoteScreenshare                      │ remoteScreenshare              │
│  └────────┬────────┘                      └────────┬────────┘              │
│           │                                        │                        │
│           ▼                                        ▼                        │
│  ┌─────────────────┐                      ┌─────────────────┐              │
│  │  call-store     │                      │  call-store     │              │
│  │  localStream    │                      │  localStream    │              │
│  │  remoteStream   │                      │  remoteStream   │              │
│  │  localScreenStream                     │  localScreenStream             │
│  │  remoteScreenStream                    │  remoteScreenStream            │
│  └────────┬────────┘                      └────────┬────────┘              │
│           │                                        │                        │
│           ▼                                        ▼                        │
│  ┌─────────────────┐                      ┌─────────────────┐              │
│  │ CallWindow.vue  │                      │ CallWindow.vue  │              │
│  │ <video> elements│                      │ <video> elements│              │
│  │ ┌─────────────┐ │                      │ ┌─────────────┐ │              │
│  │ │ Local PiP   │ │                      │ │ Local PiP   │ │              │
│  │ │ Remote Main │ │                      │ │ Remote Main │ │              │
│  │ │ Screen Share│ │                      │ │ Screen Share│ │              │
│  │ └─────────────┘ │                      │ └─────────────┘ │              │
│  └─────────────────┘                      └─────────────────┘              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Заключение

WebRTC-реализация в Forta Chat представляет собой хорошо структурированную систему с чётким разделением ответственности между слоями. Использование matrix-js-sdk-bastyon обеспечивает надёжный низкоуровневый фундамент, а слой приложения добавляет удобную абстракцию и интеграцию с Vue 3/Pinia.

Основные области для улучшения:
1. Развёртывание собственной TURN/STUN инфраструктуры
2. Добавление UI для мониторинга качества связи
3. Реализация групповых звонков
4. Улучшение механизма блокировки между вкладками
