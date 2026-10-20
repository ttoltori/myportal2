"use client";

import type {
  FieldRole,
  FieldType,
  SourceField,
} from "@myportal/api-contracts";

export const ROLE_OPTIONS: { value: FieldRole; label: string }[] = [
  { value: "none", label: "없음" },
  { value: "title", label: "제목" },
  { value: "link", label: "링크" },
  { value: "published", label: "게시일" },
  { value: "deadline", label: "마감일" },
  { value: "summary", label: "요약" },
];

export const TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: "text", label: "텍스트" },
  { value: "url", label: "URL" },
  { value: "date", label: "날짜" },
  { value: "datetime", label: "일시" },
  { value: "date_range", label: "기간" },
  { value: "number", label: "숫자" },
  { value: "image", label: "이미지" },
  { value: "tag_list", label: "태그 목록" },
];

function fieldRowValue(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export interface FieldPreviewTableProps {
  fields: SourceField[];
  rows: Record<string, unknown>[];
  onFieldsChange: (next: SourceField[]) => void;
}

/** 필드 편집 표 — 등록 화면과 재분석 패널이 같은 편집 UI를 공유한다. 상태는 부모가 가진다. */
export function FieldPreviewTable({
  fields,
  rows,
  onFieldsChange,
}: FieldPreviewTableProps) {
  const patchField = (idx: number, patch: Partial<SourceField>) =>
    onFieldsChange(fields.map((x, i) => (i === idx ? { ...x, ...patch } : x)));

  return (
    <div className="mt-2" style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            {fields.map((f, idx) => (
              <th
                key={f.key}
                style={{
                  border: "1px solid var(--rule)",
                  padding: "6px 8px",
                  verticalAlign: "top",
                  minWidth: 150,
                  opacity: f.visible ? 1 : 0.4,
                  textAlign: "left",
                }}
              >
                <input
                  className="input-line"
                  style={{ fontSize: 11 }}
                  value={f.label}
                  onChange={(e) => patchField(idx, { label: e.target.value })}
                />
                <select
                  className="input-line mt-1"
                  style={{ fontSize: 11 }}
                  value={f.type}
                  onChange={(e) =>
                    patchField(idx, { type: e.target.value as FieldType })
                  }
                >
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <select
                  className="input-line mt-1"
                  style={{ fontSize: 11 }}
                  value={f.role}
                  onChange={(e) =>
                    patchField(idx, { role: e.target.value as FieldRole })
                  }
                >
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <label
                  className="font-mono text-ink-2 flex items-center gap-1 mt-1"
                  style={{ fontSize: 11 }}
                >
                  <input
                    type="checkbox"
                    checked={!f.visible}
                    onChange={(e) =>
                      patchField(idx, { visible: !e.target.checked })
                    }
                  />
                  숨김
                </label>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>
              {fields.map((f) => {
                const mono =
                  f.type === "date" ||
                  f.type === "datetime" ||
                  f.type === "date_range" ||
                  f.type === "number" ||
                  f.type === "url";
                return (
                  <td
                    key={f.key}
                    className={mono ? "font-mono" : ""}
                    style={{
                      border: "1px solid var(--rule)",
                      padding: "5px 8px",
                      fontSize: mono ? 11 : 12,
                      verticalAlign: "top",
                      opacity: f.visible ? 1 : 0.4,
                    }}
                  >
                    {fieldRowValue(row, f.key)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
