import sys

with open('src/App.tsx', 'r') as f:
    lines = f.readlines()

custom_ui_start = -1
app_func_start = -1
return_start = -1

for i, line in enumerate(lines):
    if "// --- Custom UI Components ---" in line:
        custom_ui_start = i
    if "export default function App() {" in line:
        app_func_start = i
    if '  return (' in line and i > app_func_start:
        if 'div className="flex flex-col' in lines[i+1] or 'div className="mx-auto' in lines[i+1]:
            return_start = i

if custom_ui_start == -1 or app_func_start == -1 or return_start == -1:
    print("Could not find boundaries")
    print(f"custom_ui_start: {custom_ui_start}, app_func_start: {app_func_start}, return_start: {return_start}")
    sys.exit(1)

top_part = "".join(lines[:custom_ui_start])
app_logic_part = "".join(lines[app_func_start:return_start])

custom_components = """// --- Custom UI Components ---
import React, { useState, useRef, useEffect } from 'react';

function useOnClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (event: MouseEvent | TouchEvent) => {
      if (!ref.current || ref.current.contains(event.target as Node)) {
        return;
      }
      handler();
    };
    document.addEventListener('mousedown', listener);
    document.addEventListener('touchstart', listener);
    return () => {
      document.removeEventListener('mousedown', listener);
      document.removeEventListener('touchstart', listener);
    };
  }, [ref, handler]);
}

// 1. Field Mapping Select (Matches Screenshot 1)
function MappingSelect({ 
  value, 
  onChange, 
  options, 
  placeholder = "请选择", 
  isWarning = false 
}: { 
  value: string; 
  onChange: (val: string) => void; 
  options: {value: string; label: string}[]; 
  placeholder?: string;
  isWarning?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setIsOpen(false));

  const selectedOption = options.find(o => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex items-center justify-between px-3 py-2 text-[14px] bg-white dark:bg-[#1c1833] border rounded-[6px] transition-colors ${
          isWarning 
            ? 'border-[#ffb700] text-[#f5a623] hover:border-[#f5a623] focus:border-[#f5a623] focus:ring-1 focus:ring-[#f5a623]' 
            : 'border-[#dee0e3] text-[#1f2329] dark:border-gray-700 dark:text-gray-200 hover:border-[#3370ff] focus:border-[#3370ff]'
        }`}
      >
        <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        <span className="material-symbols-outlined text-[18px] text-[#8f959e] shrink-0 ml-2 font-light">
          unfold_more
        </span>
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 py-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.1)] max-h-60 overflow-y-auto">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`w-full text-left px-3 py-2 text-[14px] transition-colors flex items-center justify-between ${
                opt.value === value 
                  ? 'text-[#3370ff] bg-blue-50/50 dark:bg-[#3370ff]/10 font-medium' 
                  : 'text-[#1f2329] dark:text-gray-300 hover:bg-[#f5f6f7] dark:hover:bg-gray-800'
              }`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              <span className="truncate">{opt.label}</span>
              {opt.value === value && (
                <span className="material-symbols-outlined text-[16px]">check</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 2. Generic Standard Select (For Output Field)
function StandardSelect({ 
  value, 
  onChange, 
  options
}: { 
  value: string; 
  onChange: (val: string) => void; 
  options: {value: string; label: string}[]; 
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setIsOpen(false));

  const selectedOption = options.find(o => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 text-[14px] bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] text-[#1f2329] dark:text-gray-200 hover:border-[#3370ff] focus:border-[#3370ff] transition-colors"
      >
        <span className="truncate">{selectedOption?.label || '请选择'}</span>
        <span className="material-symbols-outlined text-[18px] text-[#8f959e] shrink-0 ml-2 font-light">
          unfold_more
        </span>
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1 py-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.1)] max-h-60 overflow-y-auto">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`w-full text-left px-3 py-2 text-[14px] transition-colors flex items-center justify-between ${
                opt.value === value 
                  ? 'text-[#3370ff] bg-blue-50/50 dark:bg-[#3370ff]/10 font-medium' 
                  : 'text-[#1f2329] dark:text-gray-300 hover:bg-[#f5f6f7] dark:hover:bg-gray-800'
              }`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              <span className="truncate">{opt.label}</span>
              {opt.value === value && <span className="material-symbols-outlined text-[16px]">check</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// 3. Permission Cascader (Matches Screenshot 2 & 3)
function PermissionCascader({ value, onChange }: { value: PermissionMode; onChange: (v: PermissionMode) => void }) {
  const [isScopeOpen, setIsScopeOpen] = useState(false);
  const [isRoleOpen, setIsRoleOpen] = useState(false);
  
  const scopeRef = useRef<HTMLDivElement>(null);
  const roleRef = useRef<HTMLDivElement>(null);
  
  useOnClickOutside(scopeRef, () => setIsScopeOpen(false));
  useOnClickOutside(roleRef, () => setIsRoleOpen(false));

  const scopeOptions = [
    { id: 'closed', label: '未开启' },
    { id: 'tenant', label: '组织内获得链接的人' },
    { id: 'internet', label: '互联网获得链接的人' }
  ];

  const roleOptions = [
    { id: 'readable', label: '可阅读' },
    { id: 'editable', label: '可编辑' }
  ];

  let currentScope = 'closed';
  let currentRole = 'readable';

  if (value.startsWith('tenant')) currentScope = 'tenant';
  if (value.startsWith('internet')) currentScope = 'internet';
  if (value.endsWith('editable')) currentRole = 'editable';

  const handleScopeChange = (newScope: string) => {
    if (newScope === 'closed') {
      onChange('closed');
    } else {
      onChange(`${newScope}_${currentRole}` as PermissionMode);
    }
    setIsScopeOpen(false);
  };

  const handleRoleChange = (newRole: string) => {
    if (currentScope !== 'closed') {
      onChange(`${currentScope}_${newRole}` as PermissionMode);
    }
    setIsRoleOpen(false);
  };

  const selectedScopeLabel = scopeOptions.find(o => o.id === currentScope)?.label;
  const selectedRoleLabel = roleOptions.find(o => o.id === currentRole)?.label;

  return (
    <div className="flex items-center gap-2">
      {/* Scope Dropdown */}
      <div className="relative" ref={scopeRef}>
        <button
          type="button"
          onClick={() => setIsScopeOpen(!isScopeOpen)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-[14px] bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] hover:bg-[#f5f6f7] dark:hover:bg-gray-800 transition-colors ${isScopeOpen ? 'border-[#3370ff] text-[#3370ff]' : 'text-[#1f2329] dark:text-gray-200'}`}
        >
          <span className="truncate max-w-[140px]">{selectedScopeLabel}</span>
          <span className="material-symbols-outlined text-[16px] text-[#8f959e]">expand_more</span>
        </button>

        {isScopeOpen && (
          <div className="absolute z-50 left-0 mt-1 w-[200px] py-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
            <div className="px-3 py-2 text-[12px] text-[#8f959e]">分享范围</div>
            {scopeOptions.map(opt => (
              <button
                key={opt.id}
                type="button"
                className="w-full text-left px-3 py-2 text-[14px] flex items-center justify-between hover:bg-[#f5f6f7] dark:hover:bg-gray-800 transition-colors text-[#1f2329] dark:text-gray-200"
                onClick={() => handleScopeChange(opt.id)}
              >
                <span>{opt.label}</span>
                {opt.id === currentScope && <span className="material-symbols-outlined text-[16px] text-[#3370ff]">check</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Role Dropdown (Only show if not closed) */}
      {currentScope !== 'closed' && (
        <div className="relative" ref={roleRef}>
          <button
            type="button"
            onClick={() => setIsRoleOpen(!isRoleOpen)}
            className={`flex items-center gap-1 px-2.5 py-1.5 text-[13px] bg-[#f5f6f7] dark:bg-gray-800 rounded-[6px] hover:bg-[#ebeced] dark:hover:bg-gray-700 transition-colors ${isRoleOpen ? 'text-[#3370ff]' : 'text-[#1f2329] dark:text-gray-300'}`}
          >
            <span>{selectedRoleLabel}</span>
            <span className="material-symbols-outlined text-[16px] text-[#8f959e]">expand_more</span>
          </button>

          {isRoleOpen && (
            <div className="absolute z-50 left-0 mt-1 w-[120px] py-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[6px] shadow-[0_4px_12px_rgba(0,0,0,0.1)]">
              <div className="px-3 py-2 text-[12px] text-[#8f959e]">权限</div>
              {roleOptions.map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  className="w-full text-left px-3 py-2 text-[14px] flex items-center justify-between hover:bg-[#f5f6f7] dark:hover:bg-gray-800 transition-colors text-[#1f2329] dark:text-gray-200"
                  onClick={() => handleRoleChange(opt.id)}
                >
                  <span>{opt.label}</span>
                  {opt.id === currentRole && <span className="material-symbols-outlined text-[16px] text-[#3370ff]">check</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
// --- End Custom UI Components ---
"""

new_jsx = """  return (
    <div className="flex flex-col min-h-screen bg-white dark:bg-[#131022] font-sans text-[#1f2329] dark:text-gray-100 pb-28 sm:max-w-md mx-auto relative overflow-x-hidden">
      
      {/* 极简头部 */}
      <header className="sticky top-0 z-30 px-5 py-4 bg-white/95 dark:bg-[#131022]/95 backdrop-blur-md border-b border-[#dee0e3]/60 dark:border-gray-800">
        <h1 className="text-[18px] font-semibold tracking-tight text-[#1f2329] dark:text-white">批量文档生成</h1>
        <p className="text-[13px] text-[#8f959e] mt-0.5">将表格数据填充至文档模板</p>
      </header>

      <main className="flex-1 w-full flex flex-col">
        {/* 全局通知 */}
        {notice && (
          <div className={`mx-5 mt-5 flex items-start gap-2 p-3 text-[13px] rounded-[8px] transition-all ${
            notice.type === 'error' ? 'bg-[#fff1f0] text-[#f54a45] dark:bg-red-900/20 dark:text-red-400' :
            notice.type === 'success' ? 'bg-[#f0fbf5] text-[#34c759] dark:bg-emerald-900/20 dark:text-emerald-400' :
            'bg-[#f0f4ff] text-[#3370ff] dark:bg-blue-900/20 dark:text-blue-400'
          }`}>
            <span className="material-symbols-outlined text-[16px] mt-0.5">
              {notice.type === 'error' ? 'error' : notice.type === 'success' ? 'check_circle' : 'info'}
            </span>
            <div className="leading-relaxed flex-1">{notice.text}</div>
          </div>
        )}

        {/* 模板设定 */}
        <div className="px-5 py-6">
          <div className="mb-4 text-[15px] font-semibold text-[#1f2329] dark:text-white">模板文档</div>

          <div className="flex flex-col gap-3">
            <div className="relative group">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-[#8f959e] group-focus-within:text-[#3370ff] transition-colors text-[18px]">link</span>
              <input
                className="w-full pl-9 pr-3 py-2.5 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[8px] text-[14px] focus:ring-1 focus:ring-[#3370ff] focus:border-[#3370ff] transition-all outline-none placeholder-[#8f959e]"
                placeholder="在此粘贴包含 {{变量}} 的文档链接"
                type="url"
                value={templateUrl}
                onChange={(e) => setTemplateUrl(e.target.value)}
              />
            </div>
            <button
              className="w-full py-2.5 bg-[#f5f6f7] hover:bg-[#ebeced] dark:bg-gray-800 dark:hover:bg-gray-700 text-[#1f2329] dark:text-white text-[14px] font-medium rounded-[8px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              onClick={() => void handleExtractVariables()}
              disabled={isExtracting || !templateUrl.trim()}
            >
              {isExtracting ? (
                <>
                  <span className="material-symbols-outlined text-[18px] animate-spin text-[#3370ff]">progress_activity</span>
                  <span>解析中...</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px]">sync</span>
                  <span>解析模板变量</span>
                </>
              )}
            </button>

            {templateTitle && (
              <div className="mt-2 flex items-center gap-2 text-[13px] text-[#1f2329] dark:text-gray-200">
                <span className="material-symbols-outlined text-[16px] text-[#34c759]">check_circle</span>
                <span className="truncate">{templateTitle}</span>
              </div>
            )}
          </div>
        </div>

        {variables.length > 0 && (
          <>
            <div className="h-[8px] bg-[#f5f6f7] dark:bg-[#131022]" />

            {/* 字段映射 */}
            <div className="px-5 py-6">
              <div className="mb-1 text-[15px] font-semibold text-[#1f2329] dark:text-white">字段映射</div>
              <div className="text-[13px] text-[#8f959e] mb-5">将文档内的变量映射至当前数据表的对应列</div>

              <div className="space-y-4">
                {variables.map((variable) => {
                  const isUnbound = !bindings[variable];
                  const options = [
                    { value: UNBOUND_FIELD_VALUE, label: '原样保留 (不替换)' },
                    ...fields.map(f => ({ value: f.id, label: f.name }))
                  ];

                  return (
                    <div key={variable} className="flex items-center gap-3">
                      <div className="w-[35%] shrink-0 text-[14px] text-[#1f2329] dark:text-gray-300 truncate" title={variable}>
                        {variable}
                      </div>
                      <span className="material-symbols-outlined text-[#dee0e3] dark:text-gray-600 text-[18px] shrink-0 font-light">arrow_forward</span>
                      <div className="flex-1 min-w-0">
                        <MappingSelect 
                          value={bindings[variable] || UNBOUND_FIELD_VALUE}
                          onChange={(val) => setBindings(prev => ({ ...prev, [variable]: val === UNBOUND_FIELD_VALUE ? '' : val }))}
                          options={options}
                          isWarning={isUnbound}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>

              {hasUnboundVariables && (
                <div className="mt-5 flex items-center gap-2 text-[13px] text-[#f5a623] bg-[#fff8ea] dark:bg-amber-900/10 px-4 py-3 rounded-[8px] border border-[#ffe4a8] dark:border-amber-900/30">
                  <span className="material-symbols-outlined text-[18px] text-[#f5a623]">info</span>
                  <span>未映射的变量将在生成文档时保持原样。</span>
                </div>
              )}
            </div>

            <div className="h-[8px] bg-[#f5f6f7] dark:bg-[#131022]" />

            {/* 输出设置 */}
            <div className="px-5 py-6 space-y-6">
              <div>
                <div className="mb-3 text-[14px] font-medium text-[#1f2329] dark:text-white">生成的文档链接存放于</div>
                <StandardSelect
                  value={outputFieldId || AUTO_OUTPUT_FIELD_VALUE}
                  onChange={(val) => setOutputFieldId(val === AUTO_OUTPUT_FIELD_VALUE ? '' : val)}
                  options={outputOptions}
                />
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between text-[14px] font-medium text-[#1f2329] dark:text-white">
                  <span>文档权限</span>
                </div>
                <PermissionCascader value={permissionMode} onChange={setPermissionMode} />
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between text-[14px] font-medium text-[#1f2329] dark:text-white">
                  <span>所有权转交 (可选)</span>
                </div>
                <div className="relative" ref={ownerPickerRef}>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-[#8f959e] text-[18px]">person_search</span>
                    <input
                      className="w-full pl-9 pr-8 py-2.5 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[8px] text-[14px] focus:ring-1 focus:ring-[#3370ff] focus:border-[#3370ff] transition-all outline-none placeholder-[#8f959e]"
                      placeholder="搜索姓名或花名"
                      value={ownerKeyword}
                      onChange={(e) => {
                        setOwnerKeyword(e.target.value);
                        setOwnerSelected(null);
                        setOwnerSearchHint('');
                      }}
                      onFocus={() => { if (ownerKeyword.trim() || ownerCandidates.length > 0) setOwnerSearchOpen(true); }}
                    />
                    {ownerKeyword && (
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center text-[#8f959e] hover:text-[#1f2329] hover:bg-[#f5f6f7] dark:hover:bg-gray-800 rounded transition-colors"
                        onClick={() => {
                          setOwnerKeyword('');
                          setOwnerSelected(null);
                          setOwnerCandidates([]);
                          setOwnerSearchHint('');
                          setOwnerSearchOpen(false);
                        }}
                      >
                        <span className="material-symbols-outlined text-[16px]">close</span>
                      </button>
                    )}
                  </div>
                  {ownerSearchOpen && (
                    <div className="absolute z-20 w-full mt-1 bg-white dark:bg-[#1c1833] border border-[#dee0e3] dark:border-gray-700 rounded-[8px] shadow-[0_4px_12px_rgba(0,0,0,0.1)] max-h-[240px] overflow-y-auto py-1">
                      {ownerSearchLoading ? <div className="text-[13px] text-[#8f959e] px-4 py-3 text-center">搜索中...</div> : null}
                      {!ownerSearchLoading && ownerCandidates.length === 0 ? <div className="text-[13px] text-[#8f959e] px-4 py-3 text-center">无相关人员</div> : null}
                      {!ownerSearchLoading && ownerCandidates.map(candidate => (
                        <button
                          type="button"
                          key={candidate.openId}
                          className="w-full text-left px-3 py-2.5 hover:bg-[#f5f6f7] dark:hover:bg-gray-800 flex items-center gap-3 transition-colors"
                          onClick={() => {
                            setOwnerSelected(candidate);
                            setOwnerKeyword(formatOwnerLabel(candidate));
                            setOwnerSearchOpen(false);
                            setOwnerSearchHint('');
                          }}
                        >
                          {candidate.avatar72 ? (
                            <img className="w-8 h-8 rounded-full object-cover bg-gray-100" src={candidate.avatar72} alt="" />
                          ) : (
                            <span className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[12px] font-bold" style={{ backgroundColor: getAvatarColor(candidate) }}>
                              {buildAvatarText(candidate)}
                            </span>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-[14px] text-[#1f2329] dark:text-white font-medium truncate">{formatOwnerLabel(candidate)}</div>
                            <div className="text-[12px] text-[#8f959e] truncate mt-0.5">{candidate.departments?.join(' / ') || '暂无部门'}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {ownerSearchHint && <p className="text-[12px] text-[#f54a45] mt-1.5 pl-1">{ownerSearchHint}</p>}
              </div>

            </div>

            {/* 执行结果区 */}
            {results.length > 0 && (
              <>
                <div className="h-[8px] bg-[#f5f6f7] dark:bg-[#131022]" />
                <div className="px-5 py-6 space-y-3">
                  <div className="text-[15px] font-semibold text-[#1f2329] dark:text-white mb-4">执行日志</div>
                  {results.map((result, idx) => (
                    <div key={`${result.recordId}-${idx}`} className="text-[13px] bg-[#f5f6f7] dark:bg-gray-800/30 border border-[#dee0e3] dark:border-gray-800 rounded-[8px] p-3">
                      <div className="flex justify-between items-center mb-1.5">
                        <span className="text-[#8f959e] font-mono truncate max-w-[60%]">ID: {result.recordId}</span>
                        <span className={`flex items-center gap-1 ${result.status === 'success' ? 'text-[#34c759]' : 'text-[#f54a45]'}`}>
                          <span className="material-symbols-outlined text-[16px]">{result.status === 'success' ? 'check_circle' : 'error'}</span>
                          <span>{result.status === 'success' ? '成功' : '失败'}</span>
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        {result.docUrl ? (
                          <a href={result.docUrl} target="_blank" rel="noreferrer" className="text-[#3370ff] hover:underline flex items-center gap-1 font-medium">
                            查看文档 <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                          </a>
                        ) : <span>—</span>}
                        <span className="text-[#8f959e] truncate max-w-[60%] text-right" title={result.error || formatWarnings(result.warnings) || (result.replacedBlocks ? `替换 ${result.replacedBlocks} 处` : '—')}>
                          {result.error || formatWarnings(result.warnings) || (result.replacedBlocks ? `替换 ${result.replacedBlocks} 处` : '—')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </main>

      {/* 底部悬浮操作栏 */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/95 dark:bg-[#131022]/95 backdrop-blur-md border-t border-[#dee0e3]/60 dark:border-gray-800 p-4 pb-safe z-40 sm:max-w-md sm:mx-auto">
        <div className="flex gap-3">
          <button
            className="flex-1 py-2.5 bg-white dark:bg-gray-800 border border-[#dee0e3] dark:border-gray-700 text-[#1f2329] dark:text-gray-300 text-[14px] font-medium rounded-[8px] hover:bg-[#f5f6f7] dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => void handleGenerate('selected')}
            disabled={isGenerating || !selectedRecordIds.length || !variables.length}
          >
            生成选中项
          </button>
          <button
            className="flex-1 py-2.5 bg-[#3370ff] text-white text-[14px] font-medium rounded-[8px] hover:bg-[#285bd4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 shadow-sm shadow-[#3370ff]/20"
            onClick={() => void handleGenerate('all')}
            disabled={isGenerating || !variables.length}
          >
            {isGenerating ? <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span> : <span className="material-symbols-outlined text-[18px]">rocket_launch</span>}
            <span>全部生成</span>
          </button>
        </div>
      </div>
    </div>
  );
}
"""

with open('src/App.tsx', 'w') as f:
    f.write(top_part + custom_components + app_logic_part + new_jsx)

