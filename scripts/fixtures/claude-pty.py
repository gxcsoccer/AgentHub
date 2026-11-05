import os,pty,subprocess,sys,json,select,time,fcntl,termios,struct
root=sys.argv[1]
assert root.startswith('/tmp/ah-life-') and '/' not in root[len('/tmp/ah-life-'):]
config=json.load(open(root+'/interactive-command.json'))
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
p=subprocess.Popen(config,stdin=slave,stdout=slave,stderr=slave,close_fds=True)
os.close(slave)
with open(root+'/interactive-pid.json','w') as f:json.dump({'pid':p.pid,'launcherPid':os.getpid()},f)
offset=0
with open(root+'/interactive-terminal.bin','ab',buffering=0) as output:
 while p.poll() is None:
  ready,_,_=select.select([master],[],[],0.1)
  if ready:
   try:
    data=os.read(master,65536)
    if data:output.write(data)
   except OSError:break
  try:
   with open(root+'/interactive-input.ndjson') as f:lines=f.readlines()
   for line in lines[offset:]:os.write(master,json.loads(line)['text'].encode())
   offset=len(lines)
  except FileNotFoundError:pass
os.close(master)
sys.exit(p.wait())
