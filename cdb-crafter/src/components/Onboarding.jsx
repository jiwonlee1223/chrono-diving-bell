import { useState } from "react";
import { calculateAge, parseBirthDate } from "../stageUtils";

const BIRTH_DATE_LENGTH = 8; // YYYYMMDD

export default function Onboarding({ onSubmit }) {
  const [name, setName] = useState("");
  // 화면에 보이는 값은 숫자 8자리 그대로 두고, 제출할 때만 "YYYY-MM-DD"로 옮긴다.
  const [birthDigits, setBirthDigits] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // onSubmit은 기존 프로필을 불러오는 비동기 작업이라 실패할 수 있다.
  // 실패하면 { error } 를 돌려받아 폼에 그대로 보여주고 다시 입력할 수 있게 한다.
  async function handleSubmit(e) {
    e.preventDefault();

    if (!name.trim()) {
      setError("성함을 입력해주세요.");
      return;
    }
    if (birthDigits.length < BIRTH_DATE_LENGTH) {
      setError("생년월일을 숫자 8자리로 입력해주세요. (예: 19650101)");
      return;
    }

    const birthDate = parseBirthDate(birthDigits);
    if (!birthDate) {
      setError("생년월일을 정확히 입력해주세요.");
      return;
    }

    const age = calculateAge(birthDate);
    if (Number.isNaN(age) || age < 1 || age > 120) {
      setError("생년월일을 정확히 입력해주세요.");
      return;
    }

    setSubmitting(true);
    setError("");
    const result = await onSubmit({ name: name.trim(), birthDate, age });
    if (result?.error) {
      setError(result.error);
      setSubmitting(false);
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <h1>인생 그래프</h1>
        {/* 미래 구간은 더 이상 그리지 않는다 — 지나온 시간만 그리고 다음 화면으로 넘어간다.
            뒤에 이어질 것(3일·지금 죽는다면)은 여기서 미리 말하지 않는다(CLAUDE.md §1). */}
        <p className="onboarding-desc">
          지금까지 걸어온 시간을 그래프로 그려봅니다.
          <br />
          시작하기 전에, 성함과 생년월일을 알려주세요.
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="성함"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            autoFocus
          />
          <input
            // type="number"가 아니라 text + inputMode: 숫자 키패드는 띄우되 증감 화살표와
            // 앞자리 0 삭제 같은 number 입력의 부작용은 피한다.
            type="text"
            inputMode="numeric"
            placeholder="생년월일 8자리 (예: 19650101)"
            value={birthDigits}
            maxLength={BIRTH_DATE_LENGTH}
            onChange={(e) => {
              setBirthDigits(e.target.value.replace(/\D/g, "").slice(0, BIRTH_DATE_LENGTH));
              setError("");
            }}
          />
          {error && <p className="onboarding-error">{error}</p>}
          <button type="submit" className="onboarding-submit" disabled={submitting}>
            {submitting ? "확인하는 중..." : "시작하기"}
          </button>
        </form>
      </div>
    </div>
  );
}
