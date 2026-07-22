// 얇은 에러 알림 헬퍼 — 사용자가 방금 시도한 저장이 조용히 실패해서
// 데이터가 유실됐는지 모른 채 넘어가는 상황을 방지. 콘솔 로깅은 그대로 유지하고
// sonner 토스트로 사용자에게도 알림. context 인자는 "무엇을 저장하려다 실패했나"를
// 짧게 설명 — 예: "블록 저장 실패", "메모 삭제 실패".

import { toast } from "sonner";

export function notifyError(context: string) {
  return (e: unknown) => {
    console.error(context, e);
    const description = e instanceof Error ? e.message : String(e);
    toast.error(context, { description });
  };
}
