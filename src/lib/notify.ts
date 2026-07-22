// 얇은 에러 알림 헬퍼 — 사용자가 방금 시도한 저장이 조용히 실패해서
// 데이터가 유실됐는지 모른 채 넘어가는 상황을 방지. 콘솔 로깅은 그대로 유지하고
// sonner 토스트로 사용자에게도 알림. context 인자는 "무엇을 저장하려다 실패했나"를
// 짧게 설명 — 예: "블록 저장 실패", "메모 삭제 실패".
//
// 같은 (context, message) 조합이 짧은 시간 안에 반복 발생하면 토스트는 한 번만 —
// 예전엔 DB가 잠깐 이상해지면 사용자 액션 하나하나가 실패하며 화면 오른쪽에 같은
// 문구의 토스트가 겹겹이 쌓여 UI가 마비되는 느낌이었음. 콘솔 로그는 매번 남겨서
// 디버깅에는 지장 없게 유지.

import { toast } from "sonner";

const RECENT_TTL_MS = 3000;
const recent = new Map<string, number>();

function shouldSuppress(key: string): boolean {
  const now = Date.now();
  // 누적 방지: 오래된 항목은 지나가는 김에 청소
  for (const [k, t] of recent) if (now - t > RECENT_TTL_MS) recent.delete(k);
  const last = recent.get(key);
  recent.set(key, now);
  return last !== undefined && now - last < RECENT_TTL_MS;
}

export function notifyError(context: string) {
  return (e: unknown) => {
    console.error(context, e);
    const description = e instanceof Error ? e.message : String(e);
    if (shouldSuppress(`${context}|${description}`)) return;
    toast.error(context, { description });
  };
}
