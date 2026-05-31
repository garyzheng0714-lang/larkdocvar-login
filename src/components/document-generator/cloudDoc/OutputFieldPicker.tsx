import { useRef, useState } from 'react';
import { Dropdown } from '../Dropdown';
import { FieldTypeIcon, Icon } from '../icons';
import type { TableField } from '../types';
import { AUTO_OUTPUT_FIELD } from './constants';

interface OutputFieldPickerProps {
  fields: TableField[];
  value: string;
  onChange: (fieldId: string) => void;
}

export function OutputFieldPicker({ fields, value, onChange }: OutputFieldPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = fields.find((field) => field.id === value);
  return (
    <div className="writeback-picker writeback-picker-flat">
      <button
        ref={triggerRef}
        className="fld-trigger"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        {selected ? (
          <>
            <FieldTypeIcon type={selected.type} />
            <span className="fld-name">{selected.name}</span>
          </>
        ) : (
          <span className="fld-name">自动新建链接字段</span>
        )}
        <Icon.Chevron style={{ marginLeft: 'auto', opacity: 0.5 }} />
      </button>
      <Dropdown open={open} onClose={() => setOpen(false)} align="right" width={220} triggerRef={triggerRef}>
        <button
          className={'dd-item' + (value === AUTO_OUTPUT_FIELD ? ' dd-item-on' : '')}
          type="button"
          onClick={() => {
            onChange(AUTO_OUTPUT_FIELD);
            setOpen(false);
          }}
        >
          <Icon.Plus />
          <span style={{ flex: 1, textAlign: 'left' }}>自动新建链接字段</span>
          {value === AUTO_OUTPUT_FIELD ? <Icon.Check /> : null}
        </button>
        <div className="dd-divider" />
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
      </Dropdown>
    </div>
  );
}
