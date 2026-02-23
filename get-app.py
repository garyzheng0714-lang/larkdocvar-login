with open('src/App.tsx', 'r') as f:
    lines = f.readlines()
    for i, line in enumerate(lines):
        if "export default function App() {" in line:
            print(f"App function starts at line {i}")
            break
