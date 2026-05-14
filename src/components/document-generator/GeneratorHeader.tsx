import type { ReactNode } from 'react';
import { GeneratorModeSwitch } from './GeneratorModeSwitch';
import { Icon } from './icons';
import type { GeneratorKind } from './types';

interface GeneratorHeaderProps {
  userMenu?: ReactNode;
  generatorKind: GeneratorKind;
  onGeneratorKindChange: (value: GeneratorKind) => void;
}

export function GeneratorHeader({
  userMenu,
  generatorKind,
  onGeneratorKindChange,
}: GeneratorHeaderProps) {
  return (
    <header className="hdr app-brand-header">
      <div className="hdr-main-row">
        <div className="hdr-brand" aria-label="FBIF 批量生成文档工具">
          <img className="hdr-logo" src="/fbif-logo.webp" alt="FBIF" />
          <span className="hdr-title">批量生成文档工具</span>
        </div>
        <div className="hdr-actions">
          <button className="hdr-icon" title="使用帮助" type="button"><Icon.Help /></button>
          {userMenu}
        </div>
      </div>
      <div className="hdr-mode-row">
        <GeneratorModeSwitch value={generatorKind} onChange={onGeneratorKindChange} />
      </div>
    </header>
  );
}
