// Tauri 자동 업데이터 얇은 래퍼.
//
// 흐름:
// 1) `check()`가 endpoint(예: GitHub Releases의 latest.json)를 확인해 새 버전을 반환.
// 2) 사용자가 승인하면 `downloadAndInstall()`로 패치를 내려받아 실제 설치.
// 3) 설치 후 `relaunch()`로 앱 재시작.
//
// tauri.conf.json의 plugins.updater.pubkey로 서명을 검증하므로 정상 서명 없는 릴리스는 거부됨.

import { check as tauriCheck, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateCheckResult =
  | { status: "up-to-date"; current: string }
  | { status: "available"; current: string; next: string; notes: string; update: Update }
  | { status: "error"; error: string };

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const update = await tauriCheck();
    // tauri-plugin-updater는 최신인 경우 null을 반환.
    if (!update) {
      // 현재 버전 문자열은 별도로 얻을 방법이 tauri-plugin-app에 있지만,
      // 여기선 알림 목적상 단순히 "up-to-date"만 반환.
      return { status: "up-to-date", current: "" };
    }
    return {
      status: "available",
      current: update.currentVersion,
      next: update.version,
      notes: update.body ?? "",
      update,
    };
  } catch (e: any) {
    return { status: "error", error: e?.message ?? String(e) };
  }
}

export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
