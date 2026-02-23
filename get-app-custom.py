with open('src/App.tsx', 'r') as f:
    lines = f.readlines()
    for i, line in enumerate(lines):
        if "// --- Custom UI Components ---" in line:
            print(f"Custom UI starts at line {i}")
            break
