import { useState } from "react";
import { calculateAge } from "../stageUtils";

const TODAY = new Date().toISOString().slice(0, 10);

export default function Onboarding({ onSubmit }) {
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
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
    if (!birthDate) {
      setError("생년월일을 입력해주세요.");
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
        <p className="onboarding-desc">
          지금까지 걸어온 시간과, 앞으로의 걸어갈 미래를
          <br />
          그래프로 그려봅니다.
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
            type="date"
            value={birthDate}
            max={TODAY}
            onChange={(e) => {
              setBirthDate(e.target.value);
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
