# 앱 마이그레이션 안내 (구 프로토콜 → v1)

기존 앱을 v1으로 옮길 때 필요한 대응표입니다. 규격 자체는
[`generated/PROTOCOL.md`](generated/PROTOCOL.md)를 보시고, 이 문서는 **무엇이
무엇으로 바뀌었는지**만 다룹니다.

v1은 호환되지 않습니다. 서버·관리자 웹·앱을 함께 올려야 합니다.

---

## 한눈에

- 이벤트 22개가 **8개**가 됐습니다: `hello` `read` `write` `invoke` → `ready` `state` `rejected` `ping`
- 모든 페이로드가 **객체 하나**입니다. 위치 인자와 맨값(bare value)이 없습니다
- 열거값이 **숫자에서 문자열**이 됐습니다 (`state: 1` → `playback: "playing"`)
- **거부 사유가 옵니다.** 조작이 막히면 이유를 알 수 있습니다
- **`null`이 없습니다.** 값이 없을 수 있는 자리는 태그가 붙은 유니온입니다

---

## 연결 절차

**이전** — 접속 후 다섯 번 물어보고 답을 각각 받음

```
→ getVolume  → getState  → getMute  → getCurrentSong  → getLock
← volumeChanged(46) ← stateChanged(0) ← muteChanged(0) ← songChanged("slow")
← lockChanged(false) ← adminLockChanged(false)
```

**v1** — 한 번

```
→ hello { client: "본당 태블릿", protocolVersion: 1 }
← ready { protocolVersion, accepted, attributes, commands, songs, tracks }
← state { playback, volume, mute, song, adminLock, audioLock, isAdmin, flow }
```

`hello`를 보내기 전에는 `write`·`invoke`가 거부됩니다. 접속 직후 반드시 보내십시오.

`accepted`가 `false`면 서버와 버전이 맞지 않는 것입니다. 상태는 계속 오지만 조작은
전부 `protocolMismatch`로 거부되므로, 사용자에게 **업데이트 안내**를 띄우십시오.

---

## 보내는 쪽 (C2S)

| 이전 | v1 |
| --- | --- |
| `getVolume` `getState` `getMute` `getCurrentSong` `getLock` | `read {}` |
| `getTracks` | 없음 — `ready.tracks`로 옵니다 |
| `changeVolume(50)` | `write { field: "volume", value: 50 }` |
| `changeState(1)` | `write { field: "playback", value: "playing" }` |
| `changeSong(cur, next)` | `write { field: "song", value: next }` — 현재 곡은 보내지 않습니다 |
| `changeMute(1)` | `write { field: "mute", value: "muted" }` |
| `setAdminLock(true)` | `write { field: "adminLock", value: true }` |
| `authenticateAdmin("pw")` | `invoke { command: "authenticate", args: { password: "pw" } }` |
| `micOn` | `invoke { command: "enableConsoleInput", args: { input: "mic" } }` |
| `auxOn` | `invoke { command: "enableConsoleInput", args: { input: "aux" } }` |
| `playTrackAt` `restoreSong` | 없어졌습니다 — 서버의 플로우 엔진이 씁니다 |

---

## 받는 쪽 (S2C)

| 이전 | v1 |
| --- | --- |
| `volumeChanged` `stateChanged` `muteChanged` `songChanged` `lockChanged` `adminLockChanged` | `state` 하나 — **바뀐 필드만** 담깁니다 |
| `adminAuthenticated { success: true }` | 성공은 `state { isAdmin: true }` |
| `adminAuthenticated { success: false }` | 실패는 `rejected { target: "authenticate", reason: "invalidPassword" }` |
| `tracksChanged` | `ready.tracks` |
| (없음) | `rejected { target, reason }` |
| `ping` | `ping {}` — 페이로드가 빈 객체입니다 |

### `state`는 스냅샷이 아니라 패치입니다

`state`는 **바뀐 것만** 옵니다. 통째로 갈아끼우지 말고 **병합**하십시오.

```ts
// 옳음
this.state = { ...this.state, ...patch };

// 틀림 — 안 온 필드가 사라집니다
this.state = patch;
```

없는 필드는 "바뀌지 않음"이라는 뜻이고, "값이 없음"이라는 뜻이 아닙니다.

---

## 값이 바뀐 것

| 항목 | 이전 | v1 |
| --- | --- | --- |
| 재생 상태 | `0` / `1` | `"paused"` / `"playing"` — 필드 이름도 `state` → `playback` |
| 음소거 | `0` / `1` | `"unmuted"` / `"muted"` |
| 곡 | `"slow"` / `"fast"` | `"calm"` / `"fervent"` — **아래 참고** |
| 오디오 락 | `lockChanged` | `state.audioLock` |
| 관리자 락 | `adminLockChanged` | `state.adminLock` |

### 곡 이름을 앱에 넣지 마십시오

이전에는 앱이 `slow` → "잔잔한 음악" 같은 이름표를 들고 있었습니다. 이제 서버가
알려줍니다.

```json
ready.songs = [
  { "id": "calm",    "title": "잔잔한 음악" },
  { "id": "fervent", "title": "통성기도 음악" }
]
```

이 목록으로 선택지를 그리십시오. 곡 이름이 바뀌거나 곡이 하나 더 생겨도 앱을 다시
배포할 필요가 없습니다. (`slow`/`fast`는 템포를 가리키는 이름이었는데, 실제 구분은
어떤 기도에 쓰이느냐라서 `calm`/`fervent`로 바뀌었습니다.)

---

## 새로 할 수 있는 것

### 거부 사유 보여주기

이전에는 조작이 막히면 아무 반응이 없어서, 앱이 "왜"를 말할 수 없었습니다.

```
→ write { field: "song", value: "fervent" }
← rejected { target: "song", reason: "adminLocked" }
```

주요 사유와 표시 예시입니다.

| reason | 뜻 |
| --- | --- |
| `adminLocked` | 관리자 락이 걸려 있습니다 |
| `deviceBusy` | 기기가 전환 중입니다 (페이드 진행 중) |
| `notAdmin` | 관리자만 할 수 있습니다 |
| `invalidValue` | 값이 올바르지 않습니다 |
| `invalidPassword` | 비밀번호가 틀렸습니다 |
| `protocolMismatch` | 앱 업데이트가 필요합니다 |

### 없는 기능 숨기기

`ready.attributes`와 `ready.commands`에는 **그 서버가 실제로 구현한 것만** 들어
있습니다. 목록에 없는 것은 화면에서 숨기십시오. 그러면 서버에 기능이 생겼을 때
앱을 고치지 않아도 켜집니다.

### 진행 중인 순서 보여주기

`state.flow`가 서버에서 돌고 있는 순서를 알려줍니다. 조작이 막혔을 때 이유를
보여주는 데 쓰십시오.

```ts
switch (flow.phase) {
  case "idle":    /* 아무것도 안 돌고 있음 */ break;
  case "waiting": /* `${flow.name}` · `${flow.startsAt}` 시작 예정 */ break;
  case "playing": /* `${flow.name}` · `${flow.track.index}/${flow.track.total}` */ break;
  case "holding": /* `${flow.name}` · `${flow.unlockAt}` 해제 */ break;
  default:        /* 아래 참고 */ break;
}
```

---

## 주의할 점

### 모르는 태그는 오류로 처리하십시오

`flow.phase`처럼 태그가 붙은 값에서 **모르는 값을 만나면 결함입니다.** 서버가 규격을
어겼거나 앱이 구버전이거나 둘 중 하나입니다.

이때 **빈 화면으로 두지 마십시오.** 이 앱에서 빈 상태는 "아무것도 안 돌고 있음"으로
읽히는데, 실제로는 순서가 진행 중일 수 있습니다. "알 수 없는 상태입니다. 업데이트가
필요합니다" 같은 오류 표시를 하십시오.

### 소켓 경로

서버는 기본 경로(`/`)를 씁니다. 접속 옵션에서 `path: "/api/socket"`을 **제거**하십시오.

### 관리자 권한은 연결 단위입니다

재접속하면 관리자 권한이 사라집니다. `ready`를 받은 뒤 다시 `authenticate`를
보내십시오.

### 볼륨은 계속 보내도 됩니다

`volume` 쓰기는 즉시 적용되고 오디오 락을 아주 짧게만 잡습니다. 페이더를 끄는 동안
연속으로 보내도 괜찮습니다. 반대로 `playback`과 `song`은 페이드가 있어 몇 초간 락을
잡으므로, 그 사이의 다른 오디오 조작은 `deviceBusy`로 거부됩니다.
