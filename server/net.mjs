'use strict';
/**
 * 외부 API 호출 공통 타임아웃 — "모든 외부 요청에 제한 시간을
 * 적용하라"(2026-09-10 재검토 4차)는 지시를 어댑터마다 따로 구현하지
 * 않기 위해 한 곳에 둔다.
 *
 * 중요한 한계: AbortController로 요청을 끊어도, 요청이 이미 공급자에
 * 도달한 뒤라면 "우리가 응답을 포기했다"는 것이지 "공급자가 그 요청을
 * 처리하지 않았다"는 뜻이 아니다 — 그래서 타임아웃(및 그 외 모든 네트워크
 * 예외)이 발생했을 때 "비용이 0원이었다"고 단정하지 않는다. 실제 비용
 * 처리는 호출부(routing.mjs/place-lookup.mjs)가 "실제 호출을 시도하기로
 * 결정한 시점"에 이미 비용을 확정 기록하므로(cost-ledger.mjs 참고), 이
 * 타임아웃 결과와 무관하게 그 기록은 남는다.
 *
 * **2026-09-10 재검토(5차) — ChatGPT가 지적한 문제를 고침**: 예전
 * 버전은 `fetch()`가 리졸브되자마자(= 응답 헤더만 받으면) 곧바로
 * 타이머를 껐다. 그런데 호출부(payment-toss.mjs/place-lookup.mjs)는
 * 그 뒤 별도로 `res.json()`을 불러 실제 본문을 읽는다 — 헤더는 정상으로
 * 왔는데 본문 스트림만 영원히 멈추는 응답이면, 그 단계는 이 타임아웃의
 * 보호를 전혀 못 받고 호출부가 무한정 멈출 수 있었다.
 *
 * 이제 본문을 읽는 단계도 같은 시간 제한으로 감싼다 — 응답을 그대로
 * 돌려주지 않고, `json`/`text`/`arrayBuffer` 호출 하나하나를 새 타임아웃
 * 하나씩으로 감싼 얇은 래퍼를 돌려준다. 진짜 네트워크 fetch라면
 * AbortController로 실제 소켓도 끊고, 그와 무관하게(모의 fetch처럼
 * signal을 아예 안 보는 경우까지 포함해) 정해진 시간 안에 안 끝나면
 * 무조건 타임아웃 오류로 정리한다(Promise.race와 동일한 효과 —
 * 재현 테스트: reliability-and-cost.test.mjs 8절 "본문 스트림이 멈추는
 * 응답").
 */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const ms = timeoutMs || 8000;
  const controller = new AbortController();
  let headerTimer = setTimeout(() => controller.abort(), ms);
  let res;
  try {
    res = await fetch(url, { ...(init || {}), signal: controller.signal });
  } catch (e) {
    clearTimeout(headerTimer);
    throw e;
  }
  // 헤더까지는 제한 시간 안에 왔다 — 이 타이머는 여기서 끝. 본문 읽기는
  // 아래에서 각 호출마다 새 타이머로 별도 보호한다(같은 시간 한도).
  clearTimeout(headerTimer);

  function guardBodyRead(fn) {
    return (...args) => new Promise((resolve, reject) => {
      let settled = false;
      const bodyTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        controller.abort(); // 실제 네트워크라면 소켓도 끊는다(최선 노력).
        reject(new Error('response-body-read-timeout'));
      }, ms);
      Promise.resolve().then(() => fn(...args)).then(
        (v) => { if (settled) return; settled = true; clearTimeout(bodyTimer); resolve(v); },
        (e) => { if (settled) return; settled = true; clearTimeout(bodyTimer); reject(e); },
      );
    });
  }

  const wrapped = { ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers };
  for (const key of ['json', 'text', 'arrayBuffer']) {
    if (typeof res[key] === 'function') wrapped[key] = guardBodyRead(res[key].bind(res));
  }
  return wrapped;
}
