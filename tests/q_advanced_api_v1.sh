#!/bin/bash
# Comprehensive Advanced Search Test Suite
# Tests all API endpoints with various query combinations

BASE="http://localhost:3000/api/v1"
PASS=0
FAIL=0
WARN=0

# Helper: extract fields from JSON response
parse() {
  node -e "
    const d=[];
    process.stdin.on('data',c=>d.push(c));
    process.stdin.on('end',()=>{
      try {
        const j=JSON.parse(Buffer.concat(d).toString());
        const t=j.pagination?.total ?? j.total_faculty ?? j.total ?? 'N/A';
        const m=j.mode ?? 'N/A';
        const ff=j.fuzzy_fallback ?? false;
        const msg=j.message ?? '';
        const rc=j.results?.length ?? j.departments?.length ?? 0;
        const err=j.error ?? '';
        console.log(JSON.stringify({total:t,mode:m,fuzzy:ff,msg:msg,rc:rc,err:err}));
      } catch(e) {
        console.log(JSON.stringify({total:'PARSE_ERROR',mode:'',fuzzy:false,msg:e.message,rc:0,err:e.message}));
      }
    });
  "
}

run_test() {
  local test_id="$1"
  local desc="$2"
  local method="$3"
  local endpoint="$4"
  local data="$5"
  local expect_check="$6"

  if [ "$method" = "POST" ]; then
    result=$(curl -s -X POST "${BASE}${endpoint}" -H 'Content-Type: application/json' -d "$data" | parse)
  else
    result=$(curl -s "${BASE}${endpoint}" | parse)
  fi

  total=$(echo "$result" | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const j=JSON.parse(Buffer.concat(d));console.log(j.total);})")
  mode=$(echo "$result" | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const j=JSON.parse(Buffer.concat(d));console.log(j.mode);})")
  fuzzy=$(echo "$result" | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const j=JSON.parse(Buffer.concat(d));console.log(j.fuzzy);})")
  msg=$(echo "$result" | node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{const j=JSON.parse(Buffer.concat(d));console.log(j.msg);})")

  status="?"
  case "$expect_check" in
    total_zero)
      [ "$total" = "0" ] && status="PASS" || status="FAIL"
      ;;
    total_positive)
      [ "$total" != "0" ] && [ "$total" != "N/A" ] && [ "$total" != "PARSE_ERROR" ] && status="PASS" || status="FAIL"
      ;;
    total_lte:*)
      threshold="${expect_check#total_lte:}"
      [ "$total" -le "$threshold" ] 2>/dev/null && status="PASS" || status="FAIL"
      ;;
    total_gte:*)
      threshold="${expect_check#total_gte:}"
      [ "$total" -ge "$threshold" ] 2>/dev/null && status="PASS" || status="FAIL"
      ;;
    has_error)
      [ "$total" = "N/A" ] || [ "$total" = "PARSE_ERROR" ] || [ "$total" = "0" ] && status="PASS" || status="FAIL"
      ;;
    *)
      status="INFO"
      ;;
  esac

  if [ "$status" = "PASS" ]; then
    PASS=$((PASS+1))
    icon="✅"
  elif [ "$status" = "FAIL" ]; then
    FAIL=$((FAIL+1))
    icon="❌"
  else
    icon="ℹ️"
  fi

  printf "%s [%s] %s\n" "$icon" "$test_id" "$desc"
  printf "   total=%-8s mode=%-10s fuzzy=%-6s\n" "$total" "$mode" "$fuzzy"
  if [ -n "$msg" ] && [ "$msg" != "" ]; then
    printf "   msg: %s\n" "$msg"
  fi
  echo ""
}

echo "================================================================"
echo "  ADVANCED SEARCH — COMPREHENSIVE API TEST SUITE"
echo "  $(date)"
echo "================================================================"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 1: Advanced Primary Search
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 1: Advanced Primary Search"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "1.1" "Multi-word: Carbon Nanotube (expect results)" \
  POST "/search" \
  '{"query":"Carbon Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "1.2" "Single-word: Graphene (expect results)" \
  POST "/search" \
  '{"query":"Graphene","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "1.3" "Three-word: Machine Learning Algorithm (expect results)" \
  POST "/search" \
  '{"query":"Machine Learning Algorithm","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "1.4" "Long query: 5+ words (expect results)" \
  POST "/search" \
  '{"query":"deep learning for natural language processing","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "1.5" "Gibberish single: fuyqwgasbhadgasukdh (expect 0)" \
  POST "/search" \
  '{"query":"fuyqwgasbhadgasukdh","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "1.6" "Gibberish long: qwertyuiopoiuytrewqwertyuio (expect 0)" \
  POST "/search" \
  '{"query":"qwertyuiopoiuytrewqwertyuio","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "1.7" "Gibberish multi-word: xyzabc mnodef ghijkl (expect 0)" \
  POST "/search" \
  '{"query":"xyzabc mnodef ghijkl","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "1.8" "Typo: Carbn Nanotube (expect results via fuzzy)" \
  POST "/search" \
  '{"query":"Carbn Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "1.9" "Typo: Machin Lerning (expect results via fuzzy)" \
  POST "/search" \
  '{"query":"Machin Lerning","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "1.10" "Author name in all-fields: Rajesh Khanna (expect results)" \
  POST "/search" \
  '{"query":"Rajesh Khanna","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "1.11" "Gibberish mix: asdfzxcv qwertpoi (expect 0)" \
  POST "/search" \
  '{"query":"asdfzxcv qwertpoi","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "1.12" "Mixed: Carbon xyzqwerty (expect 0 — both terms required)" \
  POST "/search" \
  '{"query":"Carbon xyzqwerty","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 2: Search-on-Search (refine_within)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 2: Search-on-Search (refine_within) — Advanced Mode"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "2.1" "Refine: 'Thermal Stability' within 'Carbon Nanotube' (narrowed)" \
  POST "/search" \
  '{"query":"Thermal Stability","refine_within":"Carbon Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "2.2" "Refine: 'Toxicity' within 'Carbon Nanotube'" \
  POST "/search" \
  '{"query":"Toxicity","refine_within":"Carbon Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "2.3" "Refine: gibberish within 'Carbon Nanotube' (expect 0)" \
  POST "/search" \
  '{"query":"qwertyuiopoiuytrewqwertyuio","refine_within":"Carbon Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "2.4" "Refine: gibberish multi-word within 'Carbon Nanotube' (expect 0)" \
  POST "/search" \
  '{"query":"xyzabc mnodef ghijkl","refine_within":"Carbon Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "2.5" "Refine: 'Solar Cell' within 'Graphene'" \
  POST "/search" \
  '{"query":"Solar Cell","refine_within":"Graphene","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "2.6" "Refine: unrelated 'Shakespeare' within 'Carbon Nanotube' (expect 0)" \
  POST "/search" \
  '{"query":"Shakespeare","refine_within":"Carbon Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "2.7" "Refine: related 'Carbon Nanofiber' within 'Carbon Nanotube'" \
  POST "/search" \
  '{"query":"Carbon Nanofiber","refine_within":"Carbon Nanotube","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "2.8" "Refine: 'polymer' within 'Graphene' (expect narrowed)" \
  POST "/search" \
  '{"query":"polymer","refine_within":"Graphene","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "2.9" "Refine: 'zzzznotaword' within 'Machine Learning' (expect 0)" \
  POST "/search" \
  '{"query":"zzzznotaword","refine_within":"Machine Learning","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 3: search_in=author
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 3: search_in=author — Advanced Mode"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "3.1" "Author search: 'Anil Verma' (expect results)" \
  POST "/search" \
  '{"query":"Anil Verma","mode":"advanced","search_in":["author"],"page":1,"per_page":5}' \
  "total_positive"

run_test "3.2" "Author search: 'Rajesh Khanna' (expect results)" \
  POST "/search" \
  '{"query":"Rajesh Khanna","mode":"advanced","search_in":["author"],"page":1,"per_page":5}' \
  "total_positive"

run_test "3.3" "Author search: gibberish (expect 0)" \
  POST "/search" \
  '{"query":"xyzabcnotaname","mode":"advanced","search_in":["author"],"page":1,"per_page":5}' \
  "total_zero"

run_test "3.4" "Author refine: 'polymer' within 'Anil Verma' search_in=author" \
  POST "/search" \
  '{"query":"polymer","refine_within":"Anil Verma","mode":"advanced","search_in":["author"],"page":1,"per_page":5}' \
  "total_positive"

run_test "3.5" "Author refine: gibberish within 'Anil Verma' search_in=author (expect 0)" \
  POST "/search" \
  '{"query":"xyzqwertnotaword","refine_within":"Anil Verma","mode":"advanced","search_in":["author"],"page":1,"per_page":5}' \
  "total_zero"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 4: Author-Scoped Search (sidebar click)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 4: Author-Scoped Search (POST /search/author-scope)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Use a real author_id from the dataset
run_test "4.1" "Author-scope: 'Carbon Nanotube' by Anil Verma (60214044700)" \
  POST "/search/author-scope" \
  '{"query":"Carbon Nanotube","author_id":"60214044700","mode":"advanced","page":1,"per_page":5}' \
  "info"

run_test "4.2" "Author-scope: 'polymer' by Anil Verma (expect results)" \
  POST "/search/author-scope" \
  '{"query":"polymer","author_id":"60214044700","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "4.3" "Author-scope: gibberish by Anil Verma (expect 0)" \
  POST "/search/author-scope" \
  '{"query":"xyzabcqwerty","author_id":"60214044700","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "4.4" "Author-scope: 'polymer' + refine 'membrane' by Anil Verma" \
  POST "/search/author-scope" \
  '{"query":"membrane","refine_within":"polymer","author_id":"60214044700","mode":"advanced","page":1,"per_page":5}' \
  "info"

run_test "4.5" "Author-scope: gibberish refine by Anil Verma (expect 0)" \
  POST "/search/author-scope" \
  '{"query":"qwertyxyzabc","refine_within":"polymer","author_id":"60214044700","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "4.6" "Author-scope: search_in=author, 'Anil Verma' by coworker" \
  POST "/search/author-scope" \
  '{"query":"Anil Verma","author_id":"60214044700","mode":"advanced","search_in":["author"],"page":1,"per_page":5}' \
  "info"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 5: Faculty for Query (People Tab)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 5: Faculty-for-Query / People Tab"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "5.1" "Faculty: 'Carbon Nanotube' advanced (expect faculty)" \
  GET "/search/faculty-for-query?query=Carbon+Nanotube&mode=advanced" \
  "total_positive"

run_test "5.2" "Faculty: 'Machine Learning' advanced (expect faculty)" \
  GET "/search/faculty-for-query?query=Machine+Learning&mode=advanced" \
  "total_positive"

run_test "5.3" "Faculty: gibberish advanced (expect 0)" \
  GET "/search/faculty-for-query?query=fuyqwgasbhadgasukdh&mode=advanced" \
  "total_zero"

run_test "5.4" "Faculty: 'Rajesh Khanna' search_in=author advanced" \
  GET "/search/faculty-for-query?query=Rajesh+Khanna&mode=advanced&search_in=author" \
  "total_positive"

run_test "5.5" "Faculty: 'Graphene' + refine 'Solar Cell' advanced" \
  GET "/search/faculty-for-query?query=Solar+Cell&mode=advanced&refine_within=Graphene" \
  "total_positive"

run_test "5.6" "Faculty: gibberish + refine 'Carbon Nanotube' (expect 0)" \
  GET "/search/faculty-for-query?query=qwertyuio&mode=advanced&refine_within=Carbon+Nanotube" \
  "total_zero"

run_test "5.7" "Faculty: 'Graphene' basic mode (expect faculty)" \
  GET "/search/faculty-for-query?query=Graphene&mode=basic" \
  "total_positive"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 6: Edge Cases
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 6: Edge Cases"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "6.1" "Single char: 'a' advanced (no crash)" \
  POST "/search" \
  '{"query":"a","mode":"advanced","page":1,"per_page":5}' \
  "info"

run_test "6.2" "Numeric: '2024' advanced" \
  POST "/search" \
  '{"query":"2024","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "6.3" "Chemical: 'C60 fullerene' advanced" \
  POST "/search" \
  '{"query":"C60 fullerene","mode":"advanced","page":1,"per_page":5}' \
  "info"

run_test "6.4" "Very long legitimate query" \
  POST "/search" \
  '{"query":"synthesis characterization and applications of carbon nanotube based polymer nanocomposites for thermal management","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "6.5" "Empty query (expect validation error)" \
  POST "/search" \
  '{"query":"","mode":"advanced","page":1,"per_page":5}' \
  "has_error"

run_test "6.6" "Whitespace-only query (expect 0)" \
  POST "/search" \
  '{"query":"   ","mode":"advanced","page":1,"per_page":5}' \
  "has_error"

run_test "6.7" "Deep pagination: page 100" \
  POST "/search" \
  '{"query":"Carbon Nanotube","mode":"advanced","page":100,"per_page":20}' \
  "info"

run_test "6.8" "Mixed real + gibberish: 'Carbon xyzqwerty' (expect 0)" \
  POST "/search" \
  '{"query":"Carbon xyzqwerty","mode":"advanced","page":1,"per_page":5}' \
  "total_zero"

run_test "6.9" "Repeated word: 'polymer polymer polymer' (expect results)" \
  POST "/search" \
  '{"query":"polymer polymer polymer","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

run_test "6.10" "Hyphenated: 'nano-composite' (expect results)" \
  POST "/search" \
  '{"query":"nano-composite","mode":"advanced","page":1,"per_page":5}' \
  "total_positive"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 7: Refine Regression (results must NEVER increase)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 7: Refine Regression — refined must be ≤ base"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_refine_regression() {
  local id="$1"
  local base_q="$2"
  local refine_q="$3"

  base_cnt=$(curl -s -X POST "${BASE}/search" -H 'Content-Type: application/json' \
    -d "{\"query\":\"${base_q}\",\"mode\":\"advanced\",\"page\":1,\"per_page\":1}" | \
    node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{console.log(JSON.parse(Buffer.concat(d)).pagination?.total??0);})")

  refine_cnt=$(curl -s -X POST "${BASE}/search" -H 'Content-Type: application/json' \
    -d "{\"query\":\"${refine_q}\",\"refine_within\":\"${base_q}\",\"mode\":\"advanced\",\"page\":1,\"per_page\":1}" | \
    node -e "const d=[];process.stdin.on('data',c=>d.push(c));process.stdin.on('end',()=>{console.log(JSON.parse(Buffer.concat(d)).pagination?.total??0);})")

  if [ "$refine_cnt" -le "$base_cnt" ] 2>/dev/null; then
    echo "  ✅ [$id] '${refine_q}' within '${base_q}': ${refine_cnt} ≤ ${base_cnt} — PASS"
    PASS=$((PASS+1))
  else
    echo "  ❌ [$id] '${refine_q}' within '${base_q}': ${refine_cnt} > ${base_cnt} — FAIL"
    FAIL=$((FAIL+1))
  fi
}

check_refine_regression "7.1" "Carbon Nanotube" "Thermal Stability"
check_refine_regression "7.2" "Carbon Nanotube" "Carbon Nanofiber"
check_refine_regression "7.3" "Graphene" "Solar Cell"
check_refine_regression "7.4" "Machine Learning" "Neural Network"
check_refine_regression "7.5" "Graphene" "polymer"
check_refine_regression "7.6" "polymer" "membrane"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SUITE 8: Basic mode cross-check (same queries)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  SUITE 8: Basic Mode Cross-Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

run_test "8.1" "Basic: 'Carbon Nanotube' (expect results)" \
  POST "/search" \
  '{"query":"Carbon Nanotube","mode":"basic","page":1,"per_page":5}' \
  "total_positive"

run_test "8.2" "Basic: gibberish (expect 0)" \
  POST "/search" \
  '{"query":"fuyqwgasbhadgasukdh","mode":"basic","page":1,"per_page":5}' \
  "total_zero"

run_test "8.3" "Basic: gibberish multi-word (expect 0)" \
  POST "/search" \
  '{"query":"xyzabc mnodef ghijkl","mode":"basic","page":1,"per_page":5}' \
  "total_zero"

run_test "8.4" "Basic refine: 'Thermal Stability' within 'Carbon Nanotube'" \
  POST "/search" \
  '{"query":"Thermal Stability","refine_within":"Carbon Nanotube","mode":"basic","page":1,"per_page":5}' \
  "total_positive"

run_test "8.5" "Basic refine: gibberish within 'Carbon Nanotube' (expect 0)" \
  POST "/search" \
  '{"query":"qwertyuio","refine_within":"Carbon Nanotube","mode":"basic","page":1,"per_page":5}' \
  "total_zero"

run_test "8.6" "Basic: author search 'Anil Verma' search_in=author" \
  POST "/search" \
  '{"query":"Anil Verma","mode":"basic","search_in":["author"],"page":1,"per_page":5}' \
  "total_positive"

# ── SUMMARY ──
echo ""
echo "================================================================"
echo "  TEST SUMMARY"
echo "================================================================"
echo "  ✅ PASSED:  $PASS"
echo "  ❌ FAILED:  $FAIL"
echo "  📊 TOTAL:   $((PASS+FAIL))"
if [ $FAIL -eq 0 ]; then
  echo "  🎉 ALL ASSERTIONS PASSED!"
else
  echo "  ⚠️  $FAIL test(s) need attention"
fi
echo "================================================================"
