import { Component } from 'react';
import type { CSSProperties, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// 侧边栏根部兜底：任何未捕获的渲染异常都会被这里接住，
// 显示一个可读的中文错误页 + 重新加载按钮，而不是让飞书 iframe 白屏。
// fallback 刻意使用内联样式，保证即使应用样式表未加载也能正常显示。
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 只记录到控制台供排查，绝不把内部错误细节渲染给终端用户。
    console.error('[ErrorBoundary] 侧边栏渲染异常：', error, info?.componentStack);
  }

  private handleReload = (): void => {
    try {
      window.location.reload();
    } catch {
      // 忽略：极端环境下 reload 不可用时，至少 fallback 文案仍在。
    }
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    return (
      <div style={wrapStyle}>
        <div style={cardStyle}>
          <div style={titleStyle}>侧边栏遇到了一点问题</div>
          <div style={descStyle}>
            页面加载时出现异常，可能是网络波动或临时故障。请重新加载试试；若反复出现，请联系技术支持。
          </div>
          <button type="button" style={buttonStyle} onClick={this.handleReload}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

const wrapStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  padding: '24px',
  boxSizing: 'border-box',
  background: '#f5f6f7',
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
};

const cardStyle: CSSProperties = {
  width: '100%',
  maxWidth: '320px',
  padding: '24px',
  borderRadius: '12px',
  background: '#ffffff',
  border: '1px solid #e5e6eb',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.06)',
  textAlign: 'center',
};

const titleStyle: CSSProperties = {
  fontSize: '15px',
  fontWeight: 600,
  color: '#1f2329',
  marginBottom: '8px',
};

const descStyle: CSSProperties = {
  fontSize: '13px',
  lineHeight: 1.6,
  color: '#646a73',
  marginBottom: '20px',
};

const buttonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '34px',
  padding: '0 20px',
  borderRadius: '6px',
  border: 'none',
  background: '#1f2329',
  color: '#ffffff',
  fontSize: '13px',
  fontWeight: 500,
  cursor: 'pointer',
};
