# 관리자 비밀번호 변경

관리자 웹은 로그인할 때 받은 비밀번호를 그대로 미디어 서버로 넘긴다. 두 파일에
같은 해시가 들어가야 한다.

- `church-media-server/.env`
- `church-admin-media-web/backend/.env`

### 1. 해시 생성

```bash
cd church-media-server
npm run hash-password -- '새비밀번호'
```

### 2. 두 파일에 넣기

```
# church-media-server/.env
ADMIN_PASSWORD_HASH=scrypt$16384$...

# church-admin-media-web/backend/.env
ADMIN_PASSWORD_HASH='scrypt$16384$...'
```

관리자 웹 쪽은 작은따옴표로 감싼다. 해시에 들어 있는 `$`가 변수로 해석되는 것을
막는다.

### 3. 재시작

미디어 서버와 관리자 웹을 모두 재시작한다. 환경변수는 기동할 때만 읽는다.

### 4. 확인

관리자 웹에 로그인한 뒤 미디어 서버 로그를 본다.

```
[INFO] Socket authenticated as admin
```

---

한쪽 파일만 바꾸면 로그인은 되지만 잠금과 순서 시작이 거부되고, 미디어 서버
로그에 `Socket failed admin authentication`이 남는다.

해시만 저장되므로 비밀번호를 분실하면 재설정해야 한다. 앱은 이 비밀번호를 쓰지
않는다.
