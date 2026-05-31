import { useRef, useState } from 'react';
import { Dropdown } from '../Dropdown';
import { FieldTypeIcon, Icon } from '../icons';
import type { TableField } from '../types';

interface CloudMapRowProps {
  variable: string;
  fields: TableField[];
  value: string;
  onChange: (fieldId: string) => void;
}

export function CloudMapRow({ variable, fields, value, onChange }: CloudMapRowProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = fields.find((field) => field.id === value);
  return (
    <div className="mrow">
      <span className="mrow-var">{variable}</span>
      <div className="mrow-field">
        <button
          ref={triggerRef}
          className={'fld-trigger' + (!selected ? ' fld-empty' : '')}
          type="button"
          onClick={() => setOpen((current) => !current)}
        >
          {selected ? (
            <>
              <FieldTypeIcon type={selected.type} />
              <span className="fld-name">{selected.name}</span>
            </>
          ) : (
            <span className="fld-placeholder">未选择</span>
          )}
          <Icon.Chevron style={{ marginLeft: 'auto', opacity: 0.5 }} />
        </button>
        <Dropdown open={open} onClose={() => setOpen(false)} width={236} triggerRef={triggerRef}>
          <div className="dd-sec-label">表中字段</div>
          {fields.map((field) => (
            <button
              key={field.id}
              className={'dd-item' + (field.id === value ? ' dd-item-on' : '')}
              type="button"
              onClick={() => {
                onChange(field.id);
                setOpen(false);
              }}
            >
              <FieldTypeIcon type={field.type} />
              <span style={{ flex: 1, textAlign: 'left' }}>{field.name}</span>
              {field.id === value ? <Icon.Check /> : null}
            </button>
          ))}
          {fields.length === 0 ? <div className="bind-empty">当前表暂无可用字段</div> : null}
        </Dropdown>
      </div>
    </div>
  );
}
