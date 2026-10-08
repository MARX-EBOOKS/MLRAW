import json
from pathlib import Path
import re
volumes = list(range(1,51))
PDF_stored_path ="../马恩全集英文"
volume_dicts=[]
for vol in volumes:
    volume_dict = {
        "id": str(vol),
        "title": f"Marx Engels Collected Works Volume {vol}",
        "shortTitle": f"Volume {vol}",
        "htmlRoot": str(vol),
        "pdf": f"{PDF_stored_path}/MECW{vol}.pdf",
        "pagePattern": f"^MECW{vol:02d}-(?<page>\\d+)\\.html?$",
        "pageLabel": "{page}",
        "toc": []
    }
    volume_dicts.append(volume_dict)
with open("MECW_reconv/MECWmap.json","w",encoding='utf-8') as f:
      json.dump(volume_dicts,f, ensure_ascii=False, indent=2)