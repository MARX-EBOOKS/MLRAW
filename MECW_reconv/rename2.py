from pathlib import Path

input_dir = Path(r'./11_rename/')
output_dir = Path(r'./11_2/')
output_dir.mkdir(exist_ok=True, parents=True)
html_files=list(Path(input_dir).rglob("*.html"))
for idx,file in enumerate(html_files):
    filename=f'MECW11-{idx:03d}.html'
    output_file=output_dir/filename
    with open(file,'r',encoding='utf-8') as f:
        content=f.read()
    with open(output_file,'w',encoding='utf-8', newline='\r\n') as f:
        f.write(content)