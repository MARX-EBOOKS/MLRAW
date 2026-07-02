from pathlib import Path
pageindex=[None]*41
pageindex[4]=[40,558,569,67,125,207,361,459]
pageindex[7]=[9,12,35,64,95,111,115,133,146,162,244,306,531,327,330,342,359,372,377,400,409]
pageindex[17]=[3,9,313,615,319,363,440]
pageindex[18]=[7,159,647,209,233,264,305,329,335,347,363,375,384,389,396,439,442,455,659,476,584,556,663]
pageindex[19]=[11,13,15,107,150,186,523,189,202,210,230,242,384,396,401,335,340,425,474]
for vol in [4,7]:
#for vol in range(4,9):
#for vol in range(17,20):
    if not pageindex[vol]:
        continue
    index_content=""
    index_file=Path(f"./23-251/{vol}/index.html")
    for p in pageindex[vol]:
        filename=f"ME{vol:02d}-{p:03d}.html"
        index_content+=f'<a href="{filename}">{p}</a><br>\n'
    index_file.write_text(index_content, encoding="utf-8", newline="\r\n")
    