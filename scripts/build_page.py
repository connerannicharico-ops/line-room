import sys
frag=open(sys.argv[1]).read()
head_end=frag.index('</style>')+len('</style>')
head=frag[:head_end].replace('<meta charset="utf-8">','')
body=frag[head_end:]
open(sys.argv[2],'w').write('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🏈</text></svg>">\n'+head+'\n</head>\n<body>\n'+body+'\n</body>\n</html>\n')
