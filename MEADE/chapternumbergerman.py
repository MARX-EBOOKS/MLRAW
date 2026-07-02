def kaptiel_no(match):
    no_groups=["Erstes Kapitel",
"Zweites Kapitel",
"Drittes Kapitel",
"Viertes Kapitel",
"Fünftes Kapitel",
"Sechstes Kapitel",
"Siebentes Kapitel",
"Achtes Kapitel",
"Neuntes Kapitel",
"Zehntes Kapitel",
"Elftes Kapitel",
"Zwölftes Kapitel",
"Dreizehntes Kapitel",
"Vierzehntes Kapitel",
"Fünfzehntes Kapitel",
"Sechzehntes Kapitel",
"Siebzehntes Kapitel",
"Achtzehntes Kapitel",
"Neunzehntes Kapitel",
"Zwanzigstes Kapitel",
"Einundzwanzigstes Kapitel",
"Zweiundzwanzigstes Kapitel",
"Dreiundzwanzigstes Kapitel",
"Vierundzwanzigstes Kapitel",
"Fünfundzwanzigstes Kapitel",
"Sechsundzwanzigstes Kapitel",
"Siebenundzwanzigstes Kapitel",
"Achtundzwanzigstes Kapitel",
"Neunundzwanzigstes Kapitel",
"Dreißigstes Kapitel",
"Einunddreißigstes Kapitel",
"Zweiunddreißigstes Kapitel",
"Dreiunddreißigstes Kapitel",
"Vierunddreißigstes Kapitel",
"Fünfunddreißigstes Kapitel",
"Sechsunddreißigstes Kapitel",
"Siebenunddreißigstes Kapitel",
"Achtunddreißigstes Kapitel",
"Neununddreißigstes Kapitel",
"Vierzigstes Kapitel",
"Einundvierzigstes Kapitel",
"Zweiundvierzigstes Kapitel",
"Dreiundvierzigstes Kapitel",
"Vierundvierzigstes Kapitel",
"Fünfundvierzigstes Kapitel",
"Sechsundvierzigstes Kapitel",
"Siebenundvierzigstes Kapitel",
"Achtundvierzigstes Kapitel",
"Neunundvierzigstes Kapitel",
"Fünfzigstes Kapitel",
"Einundfünfzigstes Kapitel",
"Zweiundfünfzigstes Kapitel",
"Dreiundfünfzigstes Kapitel",
"Vierundfünfzigstes Kapitel",
"Fünfundfünfzigstes Kapitel",
"Sechsundfünfzigstes Kapitel",
"Siebenundfünfzigstes Kapitel",
"Achtundfünfzigstes Kapitel",
"Neunundfünfzigstes Kapitel",
"Sechzigstes Kapitel"]
    number=int(match.group(2))
    heading="<h2>"+no_groups[number-1]+"<br>"+match.group(3)+"</h2>"
    return heading 
def abschnitt_no(match):
    no_groups=["Erster Abschnitt",
"Zweiter Abschnitt",
"Dritter Abschnitt",
"Vierter Abschnitt",
"Fünfter Abschnitt",
"Sechster Abschnitt",
"Siebenter Abschnitt",
"Achter Abschnitt",
"Neunter Abschnitt",
"Zehnter Abschnitt"]
    number=IVXtrans(match.group(2))
    heading="<h1>"+no_groups[number-1]+"<br>"+match.group(3)+"</h1>"
    return heading 
def IVXtrans(ivx):
    roman_map = {
        'I': 1,
        'V': 5,
        'X': 10,
        'L': 50,
        'C': 100,
        'D': 500,
        'M': 1000
    }
    
    total = 0
    prev_value = 0
    
    # 从右向左遍历，以便处理减法规则
    for char in reversed(ivx.upper()):
        if char not in roman_map:
            raise ValueError(f"无效的罗马数字字符: '{char}'")
        
        curr_value = roman_map[char]
        
        # 如果当前值小于前一个值（右侧的值），则减去当前值
        if curr_value < prev_value:
            total -= curr_value
        else:
            total += curr_value
        
        prev_value = curr_value
    
    # 可选：检查转换结果是否在合理范围（1-3999）
    if not 1 <= total <= 3999:
        raise ValueError("转换结果超出有效范围 (1-3999)，请检查输入")
    
    return total




