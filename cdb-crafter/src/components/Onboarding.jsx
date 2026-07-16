import { useState } from "react";

function calculateAge(birthDateStr) {
  const birth = new Date(birthDateStr);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const hasHadBirthdayThisYear =
    today.getMonth() > birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

const TODAY = new Date().toISOString().slice(0, 10);

export default function Onboarding({ onSubmit }) {
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e) {
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

    onSubmit({ name: name.trim(), birthDate, age });
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
          <div className="onboarding-field">
            <input
              type="date"
              className={birthDate ? "" : "is-empty"}
              value={birthDate}
              max={TODAY}
              onChange={(e) => {
                setBirthDate(e.target.value);
                setError("");
              }}
            />
            {/* type="date"는 placeholder를 지원하지 않아 사파리/모바일에서 빈 박스로
                보이므로, 값이 없을 때만 보이는 가짜 placeholder를 박스 안에 겹쳐 둔다. */}
            {!birthDate && (
              <span className="onboarding-date-placeholder">생년월일</span>
            )}
          </div>
          {error && <p className="onboarding-error">{error}</p>}
          <button type="submit">시작하기</button>
        </form>
      </div>
    </div>
  );
}
