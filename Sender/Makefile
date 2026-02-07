all:
	mkdir -p bin && rm -f bin/$@.o
	make socket 
	make sender

sender:
	gcc -O3 -march=native -flto ./src/$@.c bin/socket.o -o bin/$@ -l hiredis -lm -v
	sudo setcap 'cap_net_admin,cap_net_raw+pe' bin/$@

socket:
	gcc -c ./src/$@.c -o bin/$@.o
