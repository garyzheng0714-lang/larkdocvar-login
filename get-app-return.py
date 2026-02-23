with open('src/App.tsx', 'r') as f:
    lines = f.readlines()
    for i, line in enumerate(lines):
        if '  return (' in line and 'div className="flex flex-col min-h-screen' in lines[i+1]:
            print(f"Return starts at line {i}")
            break
