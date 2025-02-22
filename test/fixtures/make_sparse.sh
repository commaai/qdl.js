head -c 4096 </dev/urandom > raw.bin
dd if=/dev/zero bs=4096 count=1 | tr '\0' '\252' > fill.bin
head -c 4096 </dev/zero > skip.bin

cat raw.bin fill.bin skip.bin raw.bin fill.bin > test.bin

img2sparse test.bin sparse.img

# debug
sparse2img -d sparse.img

# sanity check
sparse2img sparse.img raw.img

ls -la test.bin sparse.img raw.img
cmp test.bin raw.img && echo "Success" || echo "Failure"

rm raw.bin fill.bin skip.bin test.bin
