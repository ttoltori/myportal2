# CLAUDE.md 
프로젝트 ID : myportal

## 1. 개발 개요

- 프론트엔드와 백엔드 API가 하나의 Next.js 애플리케이션(`myportal-web`)에 통합되어 있다.
- 백엔드 API는 Hono 기반으로 Next.js Route Handler(`/api/[...path]`)에서 실행된다.
- 백엔드 비즈니스 로직은 Vercel에서 실행한다.
- Supabase PostgreSQL을 데이터베이스로 사용한다.
- 데이터베이스 Schema는 `myportal`를 사용한다.
- 프론트엔드는 넓은 화면을 활용하는 웹 서비스로 개발한다.

---

## 2. 기술 스택

### 프론트엔드 (myportal-web)

- Next.js App Router
- React 19
- TypeScript
- Tailwind CSS
- 서버 데이터 요청은 `@myportal/myportal-api-client`를 통해 수행

### 백엔드 API (myportal-web 내부)

- Hono (Next.js Route Handler에서 실행)
- TypeScript
- REST API
- SQL 직접 작성
- PostgreSQL Driver (`pg`)
- 입력값 검증은 Zod 사용

### 공통 패키지

- `@myportal/api-contracts`: API 요청/응답 Schema (서비스 워크스페이스 내)
- `@myportal/myportal-api-client`: myportal API Client (서비스 워크스페이스 내)
- `@ttoltori/api-client-core`: 공통 HTTP Client (shared-packages에서 관리, GitHub npm registry에 배포)
- `@ttoltori/database`: PostgreSQL 연결 (shared-packages에서 관리, GitHub npm registry에 배포)

---

## 3. 프로젝트 구조

이 서비스는 `micro-saas/myportal-web/` 디렉터리에 있으며, 공통 패키지는 `micro-saas/shared-packages/`에서 별도 워크스페이스로 관리한다.

```text
micro-saas/
├─ shared-packages/          (공통 라이브러리 워크스페이스)
│  ├─ packages/
│  │  ├─ api-client-core/    (@ttoltori/api-client-core, 배포용)
│  │  └─ database/           (@ttoltori/database, 배포용)
│  ├─ package.json
│  ├─ pnpm-workspace.yaml
│  └─ tsconfig.base.json
│
└─ myportal-web/              (myportal 서비스 워크스페이스)
   ├─ src/                    (Next.js 통합 애플리케이션, port 3001)
   ├─ packages/
   │  ├─ api-contracts/       (@myportal/api-contracts)
   │  ├─ myportal-api-client/  (@myportal/myportal-api-client)
   │  ├─ api-client-core/     (@ttoltori/api-client-core, 로컬 복사본)
   │  └─ database/            (@ttoltori/database, 로컬 복사본)
   ├─ package.json            (name: myportal-web)
   ├─ pnpm-workspace.yaml
   ├─ tsconfig.json
   ├─ tsconfig.base.json
   ├─ next.config.ts
   ├─ vercel.json
   ├─ .npmrc                  (@ttoltori → GitHub npm registry)
   └─ .env.example
```

### shared-packages와의 관계

`@ttoltori/*` 패키지의 canonical source는 `shared-packages` 워크스페이스다.

- `shared-packages`의 패키지는 `private: false`로 설정되어 GitHub npm registry에 배포된다.
- 서비스 워크스페이스에는 동일한 패키지를 `private: true`로 로컬 복사본으로 유지하여 `workspace:*`로 참조한다.
- `.npmrc`에서 `@ttoltori` scope을 GitHub npm registry로 설정한다.
- `@ttoltori/*` 패키지를 수정할 때는 `shared-packages`의 원본을 수정하고 서비스 워크스페이스의 로컬 복사본에 동기화한다.

### 패키지 이름 규칙

- `@myportal/*`: myportal 서비스 전용 패키지 (서비스 워크스페이스 내에서만 사용)
- `@ttoltori/*`: 여러 서비스에서 공유 가능한 공통 패키지 (shared-packages에서 관리)

### 패키지 의존성 흐름

```text
myportal-web (app)
    ├─ @myportal/myportal-api-client (프론트엔드 데이터 요청)
    │    └─ @ttoltori/api-client-core (로컬 복사본)
    │    └─ @myportal/api-contracts
    ├─ @ttoltori/database (백엔드 DB 접근, 로컬 복사본)
    └─ @myportal/api-contracts
```

프론트엔드 코드는 `@ttoltori/database`를 직접 참조하지 않는다.
백엔드 코드(`src/server/`)만 `@ttoltori/database`를 참조한다.

---

## 4. 개발 명령어

```bash
# 의존성 설치
pnpm install

# 개발 서버 실행 (port 3001, 프론트엔드 + API 통합)
pnpm dev

# 빌드
pnpm build

# DB Migration
pnpm db:migrate

# DB Seed
pnpm db:seed
```

### 환경변수

`.env.example`을 참고하여 `.env.local`을 생성한다.

```env
DATABASE_URL=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
APP_BASE_URL=http://localhost:3001
LOG_LEVEL=info
NEXT_PUBLIC_API_URL=http://localhost:3001/api
```

프론트엔드는 `NEXT_PUBLIC_API_URL` 환경변수로 API base URL을 설정한다.
로컬 개발에서는 `http://localhost:3001/api`를 사용한다.

### GitHub npm registry 인증

`@ttoltori/*` 패키지를 설치하려면 `GITHUB_TOKEN` 환경변수가 필요하다.
레지스트리 매핑은 프로젝트 `.npmrc`에, 인증 토큰은 사용자 레벨 `~/.npmrc`에 둔다.

프로젝트 `.npmrc`:

```text
@ttoltori:registry=https://npm.pkg.github.com
```

사용자 레벨 `~/.npmrc`:

```text
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

pnpm은 보안상 프로젝트 `.npmrc`의 환경변수를 확장하지 않으므로 토큰을 프로젝트 `.npmrc`에 두면 경고가 출력되고 인증이 무시된다.

---

## 5. 백엔드 코드 구조의 예시

Controller와 Service를 기계적으로 분리하지 않는다.

작은 기능은 Route와 Use Case를 중심으로 단순하게 구성한다.

```text
src/server/
├─ app.ts                 (Hono Application)
├─ routes/
│  ├─ compare.routes.ts
│  ├─ quiz.routes.ts
│  ├─ leaderboard.routes.ts
│  └─ indicator.routes.ts
├─ features/
│  ├─ compare/
│  │  ├─ compare.sql.ts
│  │  └─ compare.types.ts
│  ├─ quiz/
│  │  ├─ quiz.sql.ts
│  │  └─ quiz.types.ts
│  └─ leaderboard/
│     ├─ leaderboard.sql.ts
│     └─ leaderboard.types.ts
├─ middleware/
├─ config/
├─ scripts/
│  ├─ migrate.ts
│  └─ seed.ts
└─ errors/
```

Next.js Route Handler Adapter:

```text
src/app/api/[...path]/route.ts
```

기본 호출 흐름:

```text
Next.js Route Handler (/api/[...path])
  → Hono Application (src/server/app.ts)
  → Route
  → Use Case 또는 Feature 함수
  → SQL 함수 또는 공통 라이브러리
  → Database
```

별도 Service Class나 Repository Class는 반드시 필요한 경우에만 만든다.

---

## 6. 프론트엔드 코드 구조의 예시

```text
src/
├─ app/
│  ├─ layout.tsx           (Root Layout)
│  ├─ page.tsx             (Home)
│  ├─ globals.css
│  ├─ api/
│  │  └─ [...path]/route.ts  (Hono API Route Handler)
│  ├─ compare/
│  │  ├─ page.tsx           (국가 선택)
│  │  └─ [leftCode]/[rightCode]/page.tsx  (비교 결과)
│  ├─ quiz/
│  │  ├─ page.tsx           (퀴즈 홈)
│  │  ├─ play/[sessionId]/page.tsx
│  │  └─ result/[resultId]/page.tsx
│  └─ leaderboard/
│     ├─ page.tsx
│     └─ register/page.tsx
├─ server/                  (백엔드 API 코드)
│  ├─ app.ts                (Hono Application)
│  ├─ routes/
│  ├─ features/
│  ├─ middleware/
│  ├─ config/
│  ├─ scripts/
│  └─ errors/
├─ components/
│  ├─ flag.tsx
│  ├─ country-name.tsx
│  └─ country-change-button.tsx
└─ lib/
   └─ api.ts                (API Client 인스턴스)
```

프론트엔드는 데이터베이스에 직접 접근하지 않는다.

```text
Web
  → @myportal/myportal-api-client
  → /api/* (Next.js Route Handler)
  → Hono Backend (Vercel)
  → Supabase PostgreSQL
```

Next.js Route Handler(`/api/[...path]`)는 Hono Application에 요청을 전달하는 Adapter 역할만 한다.
핵심 비즈니스 로직은 Route Handler에 직접 작성하지 않고 `src/server/`에 둔다.

---

## 7. API Client 구조

### `@myportal/api-contracts`

API 요청, 응답, 오류 코드, 공통 타입을 정의한다.

백엔드 내부 DB Row 타입이나 SQL 결과 타입은 포함하지 않는다.

### `@ttoltori/api-client-core`

공통 HTTP 기능을 제공한다.

- canonical source: `shared-packages/packages/api-client-core`
- 서비스 내 로컬 복사본: `packages/api-client-core`

Base URL 설정, Access Token 전달, Timeout, AbortSignal, 공통 응답 Parsing, 공통 오류 변환 기능을 제공한다.

서비스별 Endpoint는 포함하지 않는다.

`@ttoltori/api-client-core`를 수정할 때는 `shared-packages`의 원본을 수정하고 서비스 워크스페이스의 로컬 복사본에 동기화한다.

### `@myportal/myportal-api-client`

myportal의 공개 API 호출 함수만 제공한다.

```typescript
const client = createmyportalClient({
  baseUrl: config.myportalApiUrl,
  getAccessToken,
});

const comparison = await client.compare.getComparison('KR', 'JP');
```

API Client는 React, Next.js에 의존하지 않는 순수 TypeScript 패키지로 작성한다.

UI 상태 관리, 화면 이동, 알림 표시 등은 API Client에 넣지 않는다.

---

## 8. API 버전 관리의 예시

모든 공개 API는 URL에 버전을 포함한다.

```text
/v1/compare/KR/JP
/v1/quiz/sessions
```

기존 필드를 임의로 삭제하거나 의미를 변경하지 않는다.

가능한 변경:

- 선택 필드 추가
- 새로운 Endpoint 추가
- 새로운 오류 코드 추가
- 기존 동작을 유지하는 성능 개선

호환되지 않는 변경은 새로운 API 버전으로 제공한다.

---

## 9. Route의 책임

Route는 다음 역할을 담당할 수 있다.

- URL과 HTTP Method 정의
- 인증 Middleware 연결
- Path, Query, Body 입력값 검증
- Use Case 호출
- HTTP 응답 생성

Route 안에 복잡한 SQL이나 긴 비즈니스 로직을 직접 작성하지 않는다.

---

## 10. 비즈니스 로직 작성 원칙

비즈니스 로직은 Vercel에서 실행되는 백엔드 코드에 둔다.

Supabase Function, Trigger, Edge Function에는 핵심 비즈니스 로직을 두지 않는다.

데이터베이스에는 다음 항목만 허용한다.

- 테이블과 관계
- Foreign Key
- Unique Constraint
- Check Constraint
- Index
- View
- 단순한 데이터 무결성 Trigger
- 최소한의 공통 DB 함수
- 권한과 보안에 필요한 설정

다음 항목은 백엔드 코드에서 처리한다.

- 상태 전이
- 퀴즈 채점
- 리더보드 점수 계산
- 비교 결과 생성
- 외부 API 연동
- 사용자 행동에 따른 업무 규칙

DB Trigger에 서비스 정책이나 복잡한 상태 전이를 숨기지 않는다.

---

## 11. 데이터베이스 접근 원칙

ORM을 사용하지 않는다.

SQL을 직접 작성한다.

SQL은 문자열을 임의로 연결하지 않고 Parameter Binding을 사용한다.

```typescript
const result = await db.query(
  `
  select
      id, code, name, region, population, gdp
  from myportal.countries
  where code = $1
  `,
  [countryCode],
);
```

금지 예시:

```typescript
const sql = `select * from myportal.countries where code = '${countryCode}'`;
```

SQL Injection 방지를 위해 모든 외부 값은 Parameter Binding을 사용한다.

동적 정렬 컬럼이나 테이블 이름은 허용 목록으로 검증한다.

---

## 12. SQL 파일과 함수 구성

짧은 SQL은 Feature 파일에 둘 수 있다.

복잡하거나 재사용되는 SQL은 별도 파일로 분리한다.

```text
features/compare/
├─ get-comparison.ts
└─ compare.sql.ts
```

`compare.sql.ts` 예시:

```typescript
export const compareSql = {
  getCountry: `
    select
        id, code, name, region, population, gdp
    from myportal.countries
    where code = $1
  `,
};
```

`select *` 사용을 피하고 필요한 컬럼을 명시한다.

SQL 결과는 외부 API 응답 객체로 그대로 노출하지 않는다.

필요한 경우 Mapping 함수를 사용한다.

SQL의 소스코드가 너무 길어지지 않도록 컬럼이 10개 이상일 때는 한 줄에 나열한다.

---

## 13. 데이터베이스 Schema 규칙

서비스 데이터는 `myportal` Schema에 둔다.

```sql
select * from myportal.countries;
select * from myportal.quiz_sessions;
```

테이블명에는 서비스 prefix를 반복하지 않는다.

```text
권장: myportal.countries
비권장: public.myportal_countries
```

---

## 14. 공통 데이터베이스 라이브러리

`@ttoltori/database`는 다음 기능만 담당한다.

- canonical source: `shared-packages/packages/database`
- 서비스 내 로컬 복사본: `packages/database`

- PostgreSQL 연결 생성
- Query 실행
- Transaction 실행
- Query Logging
- 공통 오류 변환
- Timeout

```typescript
export interface DatabaseClient {
  query<T>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;

  transaction<T>(
    callback: (tx: DatabaseClient) => Promise<T>,
  ): Promise<T>;
}
```

서비스별 SQL은 `packages/database`에 넣지 않는다.

서비스별 SQL은 `src/server/features` 디렉터리에 둔다.

`@ttoltori/database`를 수정할 때는 `shared-packages`의 원본을 수정하고 서비스 워크스페이스의 로컬 복사본에 동기화한다.

---

## 15. API 응답 규칙

성공 응답:

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "..."
  }
}
```

오류 응답:

```json
{
  "success": false,
  "error": {
    "code": "COUNTRY_NOT_FOUND",
    "message": "국가를 찾을 수 없습니다.",
    "details": null
  },
  "meta": {
    "requestId": "..."
  }
}
```

클라이언트는 오류 메시지가 아니라 오류 코드를 기준으로 처리한다.

내부 SQL, Stack Trace, Secret, Provider 원본 오류를 API 응답에 노출하지 않는다.

---

## 16. 입력 검증 원칙

모든 외부 입력은 검증한다.

검증 대상:

- Path Parameter
- Query Parameter
- Request Body
- Header
- 환경변수
- 외부 API 응답

입력 검증에는 Zod를 기본으로 사용한다.

외부 데이터는 `any`가 아니라 `unknown`으로 받고 검증 후 사용한다.

---

## 17. 환경변수 원칙

모든 환경변수는 시작 시 검증한다.

핵심 코드에서 `VERCEL_URL` 같은 Vercel 전용 환경변수를 직접 사용하지 않는다.

자체 환경변수 이름을 사용하고 배포 환경에서 값을 주입한다.

---

## 18. Vercel 종속성 제한

핵심 애플리케이션 코드는 Next.js Route Handler Adapter와 분리한다.

```text
src/server/app.ts                    → Hono Application
src/app/api/[...path]/route.ts      → Next.js Route Handler Adapter
```

비즈니스 로직 안에서 Vercel SDK를 직접 사용하지 않는다.

Hono Application은 Next.js 런타임 외부에서도 테스트 가능한 순수 함수로 작성한다.

---

## 19. 데이터베이스 Migration 원칙

모든 DB 변경은 SQL Migration으로 관리한다.

```text
src/server/scripts/
├─ migrate.ts
└─ seed.ts
```

Migration으로 관리할 항목:

- Schema
- Table
- Column
- Constraint
- Foreign Key
- Index
- View
- Function
- Trigger
- Grant
- 보안 정책

운영 DB 구조를 Dashboard에서 직접 수정하지 않는다.

적용한 Migration 파일은 수정하지 않는다.

변경이 필요하면 새 Migration을 추가한다.

---

## 20. 테스트 원칙

테스트는 모든 계층을 기계적으로 작성하지 않는다.

다음 항목을 우선 테스트한다.

- 핵심 비즈니스 규칙 (예: 퀴즈 채점, 비교 결과 생성)
- SQL Query 결과 Mapping
- Transaction
- 오류 상황 처리

단순 Getter, Mapper, 얇은 Route Wrapper에는 불필요한 테스트를 만들지 않는다.

버그 수정 시 가능하면 재현 테스트를 먼저 추가한다.

---

## 21. 코드 가독성 원칙

- 파일과 함수의 역할이 이름으로 드러나야 한다.
- 하나의 함수는 하나의 주요 책임을 가진다.
- 지나치게 긴 함수는 의미 단위로 분리한다.
- 과도한 Class와 Interface를 만들지 않는다.
- 단순 함수로 충분하면 Class를 만들지 않는다.
- 재사용 가능성이 명확하지 않으면 공통화하지 않는다.
- 세 번 이상 동일한 패턴이 나타날 때 공통화를 검토한다.
- Magic String과 Magic Number를 피한다.
- 업무 규칙은 코드에서 명시적으로 보여야 한다.
- 주석은 무엇을 하는지가 아니라 왜 그렇게 하는지를 설명한다.

---

## 22. 프레임워크 사용 제한

기본적으로 다음 핵심 도구만 사용한다.

```text
Next.js
Hono
Zod
PostgreSQL Driver (pg)
Tailwind CSS
```

추가 프레임워크나 라이브러리는 다음 조건을 만족할 때만 도입한다.

- 현재 문제를 명확히 해결한다.
- 직접 구현하는 것보다 유지보수 비용이 낮다.
- 기존 도구와 역할이 중복되지 않는다.
- 제거하거나 교체하기 어렵지 않다.

ORM, Dependency Injection Container, 대형 백엔드 프레임워크는 기본적으로 도입하지 않는다.

---

## 23. 금지 사항

- ORM 사용
- 프론트엔드에서 업무 테이블 직접 수정
- 핵심 비즈니스 로직을 Supabase Trigger에 작성
- 핵심 비즈니스 로직을 Supabase Edge Function에 작성
- SQL 문자열에 외부 입력값 직접 결합
- `select *`의 무분별한 사용
- API 응답에 DB Row를 그대로 노출
- Next.js Server Action에 핵심 업무 로직 작성
- Route 파일에 긴 SQL 작성
- `any` 타입의 무분별한 사용
- 운영 DB를 Dashboard에서 직접 수정
- 불필요한 Controller, Service, Repository 계층 생성
- 단순 기능에 과도한 Design Pattern 적용

---

## 24. 구현 순서

새 기능은 다음 순서로 구현한다.

1. 기능의 목적과 Use Case를 확인한다.
2. API 입력, 출력, 오류 코드를 `@myportal/api-contracts`에 정의한다.
3. `myportal` Schema와 테이블을 확인한다.
4. 필요한 SQL을 `src/server/features/*/`에 명시적으로 작성한다.
5. 핵심 비즈니스 규칙을 Feature 함수로 구현한다.
6. 공통 기능이 필요하면 기존 `packages`를 먼저 확인한다.
7. `@ttoltori/*` 패키지 수정이 필요하면 `shared-packages`의 원본을 수정하고 로컬 복사본에 동기화한다.
8. Route와 Middleware를 연결한다.
9. 핵심 규칙과 오류 상황을 테스트한다.
10. `@myportal/myportal-api-client`에 API 호출 함수를 추가한다.
11. 프론트엔드에서 API Client를 통해 호출한다.

코드를 생성하기 전에 항상 다음을 확인한다.

- 기존 공통 패키지로 해결 가능한가?
- 코드를 새로 생성하지 않고 micro-saas 디렉토리 아래의 다른 프로젝트에서 가져와서 사용하는 것이 가능한가?
- 비즈니스 로직이 Supabase에 숨겨지지 않았는가?
- SQL이 Parameter Binding을 사용하는가?
- 불필요한 계층과 프레임워크가 추가되지 않았는가?
- 코드만 읽어도 처리 흐름을 이해할 수 있는가?
- API Client가 React, Next.js에 종속되지 않은 순수 TypeScript인가?
- Vercel 이외의 Node.js 환경에서도 실행 가능한가?


## 25. 개발 완료 조건:

1. 기존 테스트를 모두 실행한다.
2. 변경 기능의 단위 테스트를 작성한다.
3. lint를 실행한다.
4. typecheck를 실행한다.
5. 실패하면 원인을 분석하고 수정한다.
6. 모든 검증을 통과해야 작업 완료로 판단한다.
7. 최종적으로 vscode의 IDE에서 직접 실행하고 디버깅할 수 있는 launch.json을 작성한다.
8. 프로그램을 로컬에서 실행하는 방법, 환경 및 환경변수 설정, 개발 및 디버깅 절차, 서버 배포 방법을 안내하는 개발자가이드.md를 작성한다.
9. 소스는 다른 프로젝트에서 재활용가능한 기능들은 공통화시킨다.
10. 디자인 원칙에 관해서는 DESIGN.md 파일을 참조한다.
11. 모든 문서는 docs 폴더 아래에 작성한다.

## 26. AI 개발 방법:
- 고가의 opus모델은 기획,설계를 담당하고 코딩,테스트와 같은 작업은 sonnet이하의 저가 모델이 담당하게한다.
- 병행이 가능한 작업은 저가의 sonnet 이하 모델들이 병렬작업을 수행하도록 오케스트레이션한다.
- 개발이 모두 완료된 후에는 개발자가 로컬에서 바로 실행해볼 수 있는 실행 방법, 환경 설정 방법, 개발과 디버깅 방법, 서버 배포 방법을 안내하는 개발자가이드.md 파일을 작성한다.
- 개발자가 개발된 내용을 빨리 숙지하고 이해할 수 있도록 도와줄 시스템설계서.md 파일을 작성한다.
- 새 UI를 만들 때는 유사한 서비스의 디자인을 WebFetch로 1~2개 참고하고 톤을 설명할 것
- 아이콘은 lucide-react 사용, 별도 이미지 다운로드 없이 패키지에서 가져올 것
- 배경/히어로 이미지가 필요하면 Unsplash API(.env의 UNSPLASH_KEY 사용)로 검색해서 URL 삽입할 것
- 디자인 시스템 참고가 필요하면 /mnt/skills/frontend-design 규칙을 따를 것

---

## 27. 커밋 메시지

- 커밋 메시지는 항상 한글로 작성한다.
- "무엇을"보다 "왜" 변경했는지가 드러나게 쓴다.