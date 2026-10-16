#!/bin/bash
# 2D encode bench with driver-550-compatible ffmpeg 4.4 (nvenc works).
# Two input modes: PNG-pipe (the native renderer's real pipeline, incl. png decode)
# and raw YUV (isolates the ENCODER). CPU libx264/libx265 vs NVENC h264/hevc.
FF=/usr/bin/ffmpeg
D=/root/kadap/MyDisk
FR=$D/benchframes
LOG=$D/encbench2.log
N=300
: > $LOG
echo "ffmpeg: $($FF -hide_banner -version | head -1)" | tee -a $LOG
echo "driver: $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)  frames:$(ls $FR/*.png|wc -l)  1080x1920" | tee -a $LOG
# pre-decode to raw YUV once (encoder-isolated input)
cat $FR/*.png | $FF -y -v error -f image2pipe -i - -f rawvideo -pix_fmt yuv420p $D/raw.yuv
echo "== PNG-pipe (realistic pipeline: png-decode + encode) ==" | tee -a $LOG
pbench () { name="$1"; shift; s=$(date +%s.%N); cat $FR/*.png | $FF -y -v error -f image2pipe -framerate 30 -i - "$@" $D/e_$name.mp4 2>>$LOG; e=$(date +%s.%N); echo "PNG  $name: $(awk "BEGIN{printf \"%.1f\",$N/($e-$s)}") fps  ($(awk "BEGIN{printf \"%.2f\",$e-$s}")s, size=$(stat -c%s $D/e_$name.mp4 2>/dev/null))" | tee -a $LOG; }
echo "== raw-YUV (encoder-isolated) ==" | tee -a $LOG
rbench () { name="$1"; shift; s=$(date +%s.%N); $FF -y -v error -f rawvideo -pix_fmt yuv420p -s 1080x1920 -framerate 30 -i $D/raw.yuv "$@" $D/r_$name.mp4 2>>$LOG; e=$(date +%s.%N); echo "RAW  $name: $(awk "BEGIN{printf \"%.1f\",$N/($e-$s)}") fps  ($(awk "BEGIN{printf \"%.2f\",$e-$s}")s, size=$(stat -c%s $D/r_$name.mp4 2>/dev/null))" | tee -a $LOG; }
for mode in p r; do
  [ $mode = p ] && B=pbench || B=rbench
  $B cpu_h264   -c:v libx264    -crf 18 -preset medium -pix_fmt yuv420p
  $B nvenc_h264 -c:v h264_nvenc -preset p5 -cq 18 -pix_fmt yuv420p
  $B cpu_hevc   -c:v libx265    -crf 20 -preset medium -pix_fmt yuv420p -tag:v hvc1
  $B nvenc_hevc -c:v hevc_nvenc -preset p5 -cq 20 -pix_fmt yuv420p -tag:v hvc1
done
rm -f $D/raw.yuv
echo "DONE" | tee -a $LOG
