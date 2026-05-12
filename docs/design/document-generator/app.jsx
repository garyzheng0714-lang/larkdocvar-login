// App shell: wires the three screens + tweaks panel.

const { useState: useStateA, useMemo: useMemoA, useEffect: useEffectA } = React;

const ACCENTS = {
  blue:     { primary: '#2b5fed', soft: '#ecf0fe' },
  teal:     { primary: '#0d8a7c', soft: '#e3f4f1' },
  graphite: { primary: '#374254', soft: '#eceef2' },
  amber:    { primary: '#b9621a', soft: '#fbeedf' },
};

const DEFAULT_MAPPING = {
  '客户名称':   'f_name',
  '合同金额':   'f_amount',
  '签订日期':   'f_date',
  '联系人':     'f_contact',
  '联系电话':   'f_phone',
  '业务负责人': 'f_owner',
  '备注':       'f_remark',
  '客户 Logo':  'f_logo',
};

function App() {
  const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
    "accent": "blue",
    "screen": "primary",
    "showBackdrop": true,
    "density": "comfortable"
  }/*EDITMODE-END*/;
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [state, setState] = useStateA(() => ({
    template: window.MockData.TEMPLATES[0],
    mapping: { ...DEFAULT_MAPPING },
    customText: {},
    fileNameTpl: '{{客户名称}}-合同',
    selectedCount: 6,
    expires: '24 小时',
    onMissing: '停止该条',
    writeBack: true,
    writeBackField: 'f_generated',
  }));

  const [picker, setPicker] = useStateA(false);
  const [newTpl, setNewTpl] = useStateA(false);
  const [progress, setProgress] = useStateA(false);

  // Drive screen from tweaks too
  useEffectA(() => {
    if (t.screen === 'picker')      { setPicker(true);  setNewTpl(false); setProgress(false); }
    else if (t.screen === 'new')    { setPicker(false); setNewTpl(true);  setProgress(false); }
    else if (t.screen === 'progress'){ setPicker(false); setNewTpl(false); setProgress(true); }
    else { setPicker(false); setNewTpl(false); setProgress(false); }
  }, [t.screen]);

  const accent = ACCENTS[t.accent] || ACCENTS.blue;

  // Build records from selected rows for the progress modal
  const recordsForRun = useMemoA(
    () => window.MockData.TABLE_ROWS.slice(0, state.selectedCount),
    [state.selectedCount, progress]
  );

  return (
    <div className={'app density-' + t.density} style={{ '--accent': accent.primary, '--accent-soft': accent.soft }}>
      {t.showBackdrop && <BitableBackdrop />}
      <aside className="sidebar" data-screen-label="01 Sidebar — 文档生成">
        <PrimaryScreen
          state={state}
          setState={setState}
          openPicker={() => { setPicker(true); setTweak('screen', 'picker'); }}
          startGenerate={() => { setProgress(true); setTweak('screen', 'progress'); }}
          accent={accent.primary}
        />
        {picker && (
          <div className="overlay overlay-slide" data-screen-label="02 Sidebar — 选择模板">
            <PickerScreen
              initialSelectedId={state.template?.id}
              accent={accent.primary}
              onCancel={() => { setPicker(false); setTweak('screen', 'primary'); }}
              onConfirm={(tpl) => {
                setState(s => ({ ...s, template: tpl }));
                setPicker(false);
                setTweak('screen', 'primary');
              }}
              onNew={() => { setNewTpl(true); setTweak('screen', 'new'); }}
            />
          </div>
        )}
        {newTpl && (
          <div className="overlay overlay-slide" data-screen-label="03 Sidebar — 新建模板">
            <NewTemplateScreen
              accent={accent.primary}
              onCancel={() => { setNewTpl(false); setTweak('screen', 'picker'); }}
              onSave={() => { setNewTpl(false); setTweak('screen', 'picker'); }}
            />
          </div>
        )}
        {progress && (
          <ProgressModal
            records={recordsForRun}
            accent={accent.primary}
            onClose={() => { setProgress(false); setTweak('screen', 'primary'); }}
            onMinimize={() => { setProgress(false); setTweak('screen', 'primary'); }}
          />
        )}
      </aside>

      <TweaksPanel title="Tweaks" defaultPos={{ right: 16, bottom: 16 }}>
        <TweakSection title="界面">
          <TweakRadio
            label="当前画面"
            value={t.screen}
            options={[
              { value: 'primary',  label: '一级' },
              { value: 'picker',   label: '选模板' },
              { value: 'new',      label: '新建' },
              { value: 'progress', label: '生成中' },
            ]}
            onChange={(v) => setTweak('screen', v)}
          />
          <TweakToggle
            label="显示背景表格"
            value={t.showBackdrop}
            onChange={(v) => setTweak('showBackdrop', v)}
          />
          <TweakRadio
            label="密度"
            value={t.density}
            options={[
              { value: 'comfortable', label: '舒适' },
              { value: 'compact',     label: '紧凑' },
            ]}
            onChange={(v) => setTweak('density', v)}
          />
        </TweakSection>
        <TweakSection title="主题色">
          <TweakColor
            label="强调色"
            value={t.accent}
            options={Object.keys(ACCENTS).map(k => ACCENTS[k].primary)}
            onChange={(v) => {
              const key = Object.keys(ACCENTS).find(k => ACCENTS[k].primary === v) || 'blue';
              setTweak('accent', key);
            }}
          />
        </TweakSection>
        <TweakSection title="演示">
          <TweakSlider
            label="选中记录数"
            value={state.selectedCount}
            min={1} max={12} step={1}
            onChange={(v) => setState(s => ({ ...s, selectedCount: v }))}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
