fail() { printf 'Process resource limits unavailable: %s\n' "$1" >&2; exit 125; }
unit=$1
slice=$2
shift 2
group=
while IFS=: read -r hierarchy controllers path; do
  if [ "$hierarchy" = 0 ]; then group=$path; break; fi
done < /proc/self/cgroup
case "$group" in
  /*/"$unit") ;;
  *) fail 'command did not enter its cgroup v2 scope' ;;
esac
if [ "$slice" != - ]; then
  parent=${group%/*}
  case "$parent" in
    /*/"$slice") ;;
    *) fail 'command did not enter its agent tree slice' ;;
  esac
fi
while [ "$1" != -- ]; do
  field=$1
  expected=$2
  shift 2
  actual=
  read -r actual < "/sys/fs/cgroup$group/$field" || fail "$field is not readable"
  [ "$actual" = "$expected" ] || fail "$field is not enforced"
done
shift
exec "$@"
