import { useEffect, useRef, useState } from "react";

// 한 글자씩 드러내는 타이핑 효과.
// 화면을 누르면 즉시 전부 보여준다 — 기다림 자체를 강요하지는 않는다.
// instant=true면 처음부터 다 보여준다(앞뒤로 오가며 같은 문장을 다시 볼 때).
export default function Typewriter({ text, speed = 70, instant = false, onDone }) {
  const [shown, setShown] = useState(instant ? text.length : 0);
  const timerRef = useRef(null);
  // onDone은 렌더마다 새 함수라 의존성에 넣으면 타이핑이 계속 처음부터 다시 시작된다.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (instant) {
      setShown(text.length);
      doneRef.current?.();
      return;
    }
    setShown(0);
    let i = 0;
    timerRef.current = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= text.length) {
        clearInterval(timerRef.current);
        doneRef.current?.();
      }
    }, speed);
    return () => clearInterval(timerRef.current);
  }, [text, speed, instant]);

  const finished = shown >= text.length;

  function revealAll() {
    if (finished) return;
    clearInterval(timerRef.current);
    setShown(text.length);
    doneRef.current?.();
  }

  return (
    <p className="typewriter" onClick={revealAll}>
      {text.slice(0, shown)}
      {!finished && <span className="typewriter-caret" />}
    </p>
  );
}
