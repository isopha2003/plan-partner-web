import { useEffect, useRef, useState } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 브라우저 Document PiP를 대체하는 진짜 Tauri 자식 창 — 다른 앱 위에서도 계속 떠 있고
// 테두리가 전혀 없음(frameless/transparent/alwaysOnTop). 상태 동기화는 useTimerBroadcast의
// emit/listen("timer:state" / "timer:action")로 이루어짐 — 여기선 창 생성/파괴만 다룸.
export function useTimerWindow() {
  const [isOpen, setIsOpen] = useState(false);
  const winRef = useRef<WebviewWindow | null>(null);

  const open = async () => {
    const existing = await WebviewWindow.getByLabel("timer");
    if (existing) {
      winRef.current = existing;
      setIsOpen(true);
      return;
    }
    const win = new WebviewWindow("timer", {
      url: "/timer.html",
      width: 260,
      height: 120,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      title: "타이머",
      // Windows에서 WebView2의 파일 드래그앤드롭 기능이 data-tauri-drag-region으로 창을
      // 옮기는 기능과 내부적으로 충돌해 꺼야 창 이동이 정상 동작함
      dragDropEnabled: false,
    });
    winRef.current = win;
    win.once("tauri://error", (e) => console.error("타이머 창 생성 실패", e));
    win.once("tauri://created", () => setIsOpen(true));
    win.once("tauri://destroyed", () => {
      winRef.current = null;
      setIsOpen(false);
    });
  };

  const close = () => {
    winRef.current?.close();
  };

  // 메인 창을 닫으면 뜬 타이머 창도 함께 닫아서 프로세스 전체가 종료되도록 함.
  // onCloseRequested는 Promise로 unlisten을 돌려줌 — cleanup이 promise 이전에
  // 실행되면 unlisten이 안 되므로, cancelled 플래그를 두고 promise resolve 후에도
  // 정리 가능하도록 함.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async () => {
        await winRef.current?.close();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { isOpen, open, close };
}
