"""Run website code exactly as displayed; trusted offline Docker verification only."""
import json
import sys
import entrypoint

jobs=json.load(sys.stdin)
report={'problems':0,'cases':0,'references':0,'rejectedStarters':0,'alternatives':0,'failures':[]}
for job in jobs:
    report['problems']+=1
    for label,code,expected in [('reference',job['referenceCode'],True),('starter',job['starterCode'],False), *[(a['title'],a['code'],True) for a in job.get('solutionAlternatives',[])]]:
        result=entrypoint.run({
            'protocolVersion':2, 'problemId':job['id'], 'problemVersion':job['problemVersion'],
            'spec':job['spec'], 'code':code, 'mode':'submit',
        })
        passed=bool(result['cases']) and all(c.get('passed') for c in result['cases'])
        if passed!=expected:
            report['failures'].append({'id':job['id'],'variant':label,'result':result})
        elif label=='reference':report['references']+=1;report['cases']+=len(result['cases'])
        elif label=='starter':report['rejectedStarters']+=1
        else:report['alternatives']+=1
print(json.dumps(report))
sys.exit(bool(report['failures']))
