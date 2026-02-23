import sys
import re

with open('src/App.tsx', 'r') as f:
    content = f.read()

# Find where the component return starts
return_idx = content.find('  return (\n    <div className="flex flex-col min-h-screen')
if return_idx == -1:
    return_idx = content.find('  return (\n')

top_part = content[:return_idx]

# We need to add CustomSelect outside App or inside App.
# Actually, better to add it just before "export default function App() {"

custom_components = """
// --- Custom UI Components ---
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

function CustomSelect({ 
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
        className={`w-full flex items-center justify-between px-3 py-2 text-[13px] bg-white dark:bg-gray-800 border rounded-lg transition-all ${
          isWarning 
            ? 'border-amber-400 text-amber-600 hover:border-amber-500 hover:bg-amber-50/50 dark:border-amber-600 dark:text-amber-500' 
            : 'border-gray-200 text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300'
        } ${isOpen ? 'ring-2 ring-primary/20 border-primary' : ''}`}
      >
        <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        <span className="material-symbols-outlined text-[16px] text-gray-400 shrink-0 ml-2">
          expand_more
        </span>
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1.5 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center justify-between ${
                opt.value === value 
                  ? 'text-primary bg-primary/5 dark:bg-primary/10 font-medium' 
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
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

function PermissionSelect({ value, onChange }: { value: PermissionMode; onChange: (v: PermissionMode) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setIsOpen(false));

  const options = [
    { value: 'closed', label: '未开启', desc: '仅协作者或访问过的人可阅读' },
    { value: 'tenant_readable', label: '组织内获得链接的人可阅读', desc: '组织内人员可通过链接访问' },
    { value: 'internet_readable', label: '互联网获得链接的人可阅读', desc: '任何人可通过链接访问' }
  ];

  const selected = options.find(o => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full flex flex-col px-3 py-2 text-left bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 rounded-lg transition-all ${isOpen ? 'ring-2 ring-primary/20 border-primary' : ''}`}
      >
        <div className="flex items-center justify-between w-full">
          <span className="text-[13px] font-medium text-gray-900 dark:text-gray-100">{selected?.label}</span>
          <span className="material-symbols-outlined text-[16px] text-gray-400">expand_more</span>
        </div>
        <span className="text-[11px] text-gray-500 mt-0.5">{selected?.desc}</span>
      </button>

      {isOpen && (
        <div className="absolute z-50 w-full mt-1.5 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl">
          <div className="px-3 py-1.5 text-[11px] font-medium text-gray-400 mb-1 border-b border-gray-100 dark:border-gray-700/50">分享范围</div>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`w-full text-left px-3 py-2 transition-colors flex items-center justify-between ${
                opt.value === value ? 'bg-primary/5 dark:bg-primary/10' : 'hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
              onClick={() => {
                onChange(opt.value as PermissionMode);
                setIsOpen(false);
              }}
            >
              <span className={`text-[13px] truncate ${opt.value === value ? 'text-primary font-medium' : 'text-gray-700 dark:text-gray-300'}`}>
                {opt.label}
              </span>
              {opt.value === value && <span className="material-symbols-outlined text-[16px] text-primary">check</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
// --- End Custom UI Components ---
"""

# Let's inject imports if React hooks are missing. But they are likely already imported.
# Let's just put it before "export default function App() {"
app_idx = top_part.find('export default function App() {')
if app_idx != -1:
    top_part = top_part[:app_idx] + custom_components + "\n" + top_part[app_idx:]

new_jsx = """  return (
    <div className="flex flex-col min-h-screen bg-white dark:bg-[#131022] font-sans text-[#1f2329] dark:text-gray-100 pb-28 sm:max-w-md mx-auto relative overflow-x-hidden">
      
      {/* 极简头部 */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-5 py-4 bg-white/80 dark:bg-[#131022]/80 backdrop-blur-md border-b border-gray-100 dark:border-gray-800/50">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[#3370ff] text-[20px]">description</span>
          <h1 className="text-[15px] font-semibold tracking-tight text-gray-900 dark:text-white">批量生成文档</h1>
        </div>
      </header>

      <main className="flex-1 w-full flex flex-col">
        {/* 全局通知 */}
        {notice && (
          <div className={`mx-5 mt-4 flex items-start gap-2 p-3 text-[13px] rounded-lg border transition-all ${
            notice.type === 'error' ? 'bg-red-50 border-red-100 text-red-700 dark:bg-red-900/20 dark:border-red-900/30 dark:text-red-400' :
            notice.type === 'success' ? 'bg-emerald-50 border-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-900/30 dark:text-emerald-400' :
            'bg-blue-50 border-blue-100 text-blue-700 dark:bg-blue-900/20 dark:border-blue-900/30 dark:text-blue-400'
          }`}>
            <span className="material-symbols-outlined text-[16px] mt-0.5">
              {notice.type === 'error' ? 'error' : notice.type === 'success' ? 'check_circle' : 'info'}
            </span>
            <div className="leading-relaxed flex-1">{notice.text}</div>
          </div>
        )}

        {/* 无边界排版流 */}
        <div className="px-5 py-6">
          <div className="mb-2 text-[14px] font-medium text-gray-900 dark:text-white">设定模板文档</div>
          <div className="text-[12px] text-gray-500 mb-4">输入包含 {"{{变量}}"} 的飞书文档链接开始解析。</div>

          <div className="flex gap-2">
            <div className="relative flex-1 group">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-gray-400 text-[16px]">link</span>
              <input
                className="w-full pl-9 pr-3 py-2 bg-gray-50/50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700/80 rounded-lg text-[13px] focus:bg-white dark:focus:bg-gray-800 focus:ring-2 focus:ring-[#3370ff]/20 focus:border-[#3370ff] transition-all outline-none placeholder-gray-400"
                placeholder="https://larksuite.com/docs/..."
                type="url"
                value={templateUrl}
                onChange={(e) => setTemplateUrl(e.target.value)}
              />
            </div>
            <button
              className="px-4 py-2 bg-[#3370ff] hover:bg-[#285bd4] text-white text-[13px] font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[72px]"
              onClick={() => void handleExtractVariables()}
              disabled={isExtracting || !templateUrl.trim()}
            >
              {isExtracting ? <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span> : '解析'}
            </button>
          </div>

          {templateTitle && (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/50 text-gray-700 dark:text-gray-300 text-[12px] rounded-lg border border-gray-100 dark:border-gray-800">
              <span className="material-symbols-outlined text-[16px] text-emerald-500">check_circle</span>
              <span className="font-medium truncate flex-1">{templateTitle}</span>
            </div>
          )}
        </div>

        {variables.length > 0 && (
          <>
            <div className="h-[1px] bg-gray-100 dark:bg-gray-800/50 mx-5" />

            {/* 字段映射区 */}
            <div className="px-5 py-6">
              <div className="mb-2 text-[14px] font-medium text-gray-900 dark:text-white">字段映射</div>
              <div className="text-[12px] text-gray-500 mb-5">将文档内的变量映射至当前数据表的对应列</div>

              <div className="space-y-3">
                {variables.map((variable) => {
                  const isUnbound = !bindings[variable];
                  const options = [
                    { value: UNBOUND_FIELD_VALUE, label: '原样保留 (不替换)' },
                    ...fields.map(f => ({ value: f.id, label: f.name }))
                  ];

                  return (
                    <div key={variable} className="flex items-center gap-3">
                      <div className="w-[38%] shrink-0 text-[13px] text-gray-700 dark:text-gray-300 truncate" title={variable}>
                        {variable}
                      </div>
                      <span className="material-symbols-outlined text-gray-300 dark:text-gray-600 text-[16px] shrink-0">arrow_forward</span>
                      <div className="flex-1 min-w-0">
                        <CustomSelect 
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
                <div className="mt-4 flex items-start gap-2 text-[12px] text-amber-600 bg-amber-50/50 dark:bg-amber-900/10 px-3 py-2.5 rounded-lg border border-amber-100/50 dark:border-amber-900/20">
                  <span className="material-symbols-outlined text-[16px] mt-0.5">info</span>
                  <span className="leading-relaxed">未映射的变量将在生成文档时保持原样。</span>
                </div>
              )}
            </div>

            <div className="h-[1px] bg-gray-100 dark:bg-gray-800/50 mx-5" />

            {/* 输出设置区 */}
            <div className="px-5 py-6 space-y-6">
              <div>
                <div className="mb-3 text-[13px] font-medium text-gray-900 dark:text-white">生成的文档链接存放于</div>
                <CustomSelect
                  value={outputFieldId || AUTO_OUTPUT_FIELD_VALUE}
                  onChange={(val) => setOutputFieldId(val === AUTO_OUTPUT_FIELD_VALUE ? '' : val)}
                  options={outputOptions}
                />
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between text-[13px] font-medium text-gray-900 dark:text-white">
                  <span>转交文档所有权至</span>
                  <span className="text-[11px] font-normal text-gray-400">可选</span>
                </div>
                <div className="relative" ref={ownerPickerRef}>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-gray-400 text-[16px]">search</span>
                    <input
                      className="w-full pl-9 pr-8 py-2 bg-gray-50/50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700/80 rounded-lg text-[13px] focus:bg-white dark:focus:bg-gray-800 focus:ring-2 focus:ring-[#3370ff]/20 focus:border-[#3370ff] transition-all outline-none placeholder-gray-400"
                      placeholder="搜索姓名或花名..."
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
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
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
                    <div className="absolute z-20 w-full mt-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg max-h-[220px] overflow-y-auto py-1">
                      {ownerSearchLoading ? <div className="text-[12px] text-gray-400 px-4 py-3 text-center">搜索中...</div> : null}
                      {!ownerSearchLoading && ownerCandidates.length === 0 ? <div className="text-[12px] text-gray-400 px-4 py-3 text-center">无相关人员</div> : null}
                      {!ownerSearchLoading && ownerCandidates.map(candidate => (
                        <button
                          type="button"
                          key={candidate.openId}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2.5 transition-colors"
                          onClick={() => {
                            setOwnerSelected(candidate);
                            setOwnerKeyword(formatOwnerLabel(candidate));
                            setOwnerSearchOpen(false);
                            setOwnerSearchHint('');
                          }}
                        >
                          {candidate.avatar72 ? (
                            <img className="w-6 h-6 rounded-full object-cover bg-gray-100" src={candidate.avatar72} alt="" />
                          ) : (
                            <span className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold" style={{ backgroundColor: getAvatarColor(candidate) }}>
                              {buildAvatarText(candidate)}
                            </span>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] text-gray-900 dark:text-white font-medium truncate">{formatOwnerLabel(candidate)}</div>
                            <div className="text-[11px] text-gray-500 truncate mt-0.5">{candidate.departments?.join(' / ') || '暂无部门'}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {ownerSearchHint && <p className="text-[11px] text-red-500 mt-1.5 pl-1">{ownerSearchHint}</p>}
              </div>

              <div>
                <div className="mb-3 text-[13px] font-medium text-gray-900 dark:text-white">文档权限</div>
                <PermissionSelect value={permissionMode} onChange={setPermissionMode} />
              </div>
            </div>

            {/* 执行结果区 */}
            {results.length > 0 && (
              <>
                <div className="h-[1px] bg-gray-100 dark:bg-gray-800/50 mx-5" />
                <div className="px-5 py-6 space-y-3">
                  <div className="text-[14px] font-medium text-gray-900 dark:text-white mb-4">执行日志</div>
                  {results.map((result, idx) => (
                    <div key={`${result.recordId}-${idx}`} className="text-[12px] bg-gray-50/50 dark:bg-gray-800/30 border border-gray-100 dark:border-gray-800 rounded-lg p-3">
                      <div className="flex justify-between items-center mb-1.5">
                        <span className="text-gray-500 font-mono">ID: {result.recordId}</span>
                        <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${result.status === 'success' ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 dark:text-emerald-400' : 'text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400'}`}>
                          {result.status === 'success' ? '成功' : '失败'}
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        {result.docUrl ? (
                          <a href={result.docUrl} target="_blank" rel="noreferrer" className="text-[#3370ff] hover:underline flex items-center gap-1 font-medium">
                            查看文档 <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                          </a>
                        ) : <span>—</span>}
                        <span className="text-gray-500 truncate max-w-[60%] text-right" title={result.error || formatWarnings(result.warnings) || (result.replacedBlocks ? `替换 ${result.replacedBlocks} 处` : '—')}>
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
      <div className="fixed bottom-0 left-0 right-0 bg-white/90 dark:bg-[#131022]/90 backdrop-blur-md border-t border-gray-100 dark:border-gray-800 p-4 pb-safe z-40 sm:max-w-md sm:mx-auto">
        {!variables.length ? (
          <button disabled className="w-full py-2.5 bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 text-[14px] font-medium rounded-lg cursor-not-allowed">
            解析模板后生成
          </button>
        ) : (
          <div className="flex gap-3">
            <button
              className="flex-1 py-2.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 text-[13px] font-medium rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => void handleGenerate('selected')}
              disabled={isGenerating || !selectedRecordIds.length}
            >
              生成选中项
            </button>
            <button
              className="flex-1 py-2.5 bg-[#3370ff] text-white text-[13px] font-medium rounded-lg hover:bg-[#285bd4] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5 shadow-sm shadow-[#3370ff]/20"
              onClick={() => void handleGenerate('all')}
              disabled={isGenerating}
            >
              {isGenerating ? <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span> : <span className="material-symbols-outlined text-[16px]">magic_button</span>}
              {isGenerating ? '生成中...' : '生成全部'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
"""

with open('src/App.tsx', 'w') as f:
    f.write(top_part + new_jsx)

