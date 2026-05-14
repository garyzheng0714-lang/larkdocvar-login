import type { GeneratorKind } from './types';

interface GeneratorModeSwitchProps {
  value: GeneratorKind;
  onChange: (value: GeneratorKind) => void;
}

const OPTIONS: Array<{ value: GeneratorKind; label: string }> = [
  { value: 'word', label: 'Word 文档' },
  { value: 'feishu', label: '飞书云文档' },
];

export function GeneratorModeSwitch({ value, onChange }: GeneratorModeSwitchProps) {
  return (
    <div className="doc-kind-switch" role="tablist" aria-label="生成模板类型">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          className={'doc-kind-option' + (value === option.value ? ' is-active' : '')}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
