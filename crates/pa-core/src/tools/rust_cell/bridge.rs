use super::{guest::Guest, host, process, OnUpdate};
use crate::tools::tool_definition::{ToolContentBlock, ToolUpdate};
use anyhow::{bail, ensure, Context, Result};
use futures::{
    stream::{FuturesUnordered, StreamExt},
    FutureExt,
};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const FRAME_LIMIT: usize = 32 * 1024 * 1024;
#[derive(Default)]
pub(super) struct Display {
    pub diffs: Vec<Value>,
    pub attachments: Vec<Value>,
    pub messages: Vec<Value>,
}
pub(super) struct Output {
    pub display: Display,
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}
struct Decoder {
    prefix: Vec<u8>,
    pending: Vec<u8>,
    frame: Option<Vec<u8>>,
}
enum Part {
    Text(Vec<u8>),
    Frame(Value),
}
impl Decoder {
    fn push(&mut self, bytes: &[u8]) -> Result<Vec<Part>> {
        self.pending.extend_from_slice(bytes);
        let chunk = std::mem::take(&mut self.pending);
        let mut data = chunk.as_slice();
        let mut output = Vec::new();
        while !data.is_empty() {
            if let Some(frame) = &mut self.frame {
                let newline = data.iter().position(|c| *c == b'\n');
                let end = newline.unwrap_or(data.len());
                ensure!(
                    frame.len() + end <= FRAME_LIMIT,
                    "guest bridge frame exceeds size limit"
                );
                frame.extend_from_slice(&data[..end]);
                if newline.is_none() {
                    break;
                }
                let value = serde_json::from_slice(frame).context("invalid guest bridge frame")?;
                output.push(Part::Frame(value));
                self.frame = None;
                data = &data[end + 1..];
            } else if let Some(pos) = data
                .windows(self.prefix.len())
                .position(|s| s == self.prefix)
            {
                if pos > 0 {
                    output.push(Part::Text(data[..pos].to_vec()));
                }
                self.frame = Some(Vec::new());
                data = &data[pos + self.prefix.len()..];
            } else {
                let held = (1..=data.len().min(self.prefix.len() - 1))
                    .rev()
                    .find(|n| data.ends_with(&self.prefix[..*n]))
                    .unwrap_or(0);
                let end = data.len() - held;
                if end > 0 {
                    output.push(Part::Text(data[..end].to_vec()));
                }
                self.pending.extend_from_slice(&data[end..]);
                break;
            }
        }
        Ok(output)
    }
}
async fn reply(input: &mut tokio::process::ChildStdin, frame: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(frame)?;
    bytes.push(b'\n');
    input.write_all(&bytes).await?;
    Ok(())
}
fn emit(kind: &str, payload: &Value, display: &mut Display) -> Result<()> {
    match kind {
        "display.diff"
            if ["path", "oldStr", "newStr"]
                .iter()
                .all(|s| payload[s].is_string()) =>
        {
            display.diffs.push(payload.clone())
        }
        "display.attachment" => {
            let data = payload["data"]
                .as_str()
                .context("missing attachment data")?;
            let mime = payload["mimeType"]
                .as_str()
                .context("missing attachment mimeType")?;
            ensure!(
                data.len() <= 28 * 1024 * 1024,
                "attachment exceeds wire size"
            );
            display
                .attachments
                .push(host::attachment(mime, data, payload.get("path"))?);
        }
        _ => {}
    }
    Ok(())
}
pub(super) async fn run(
    mut cmd: Command,
    guest: &Guest<'_>,
    id: &str,
    code: &str,
    token: &str,
    updates: Option<&OnUpdate>,
) -> Result<Output> {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut group = process::ChildGroup::spawn(&mut cmd)?;
    let mut input = group.child.stdin.take().context("missing guest stdin")?;
    let mut output = group.child.stdout.take().context("missing guest stdout")?;
    let err = group.child.stderr.take().context("missing guest stderr")?;
    let conversation = async {
        let mut decoder = Decoder {
            prefix: format!("\x1eRLM:{token}:").into_bytes(),
            frame: None,
            pending: Vec::new(),
        };
        let mut authenticated = false;
        let mut buffer = [0; 16384];
        let mut stdout = Vec::new();
        let mut truncated = false;
        let mut pending = FuturesUnordered::new();
        let mut display = Display::default();
        loop {
            tokio::select! {
                n=output.read(&mut buffer)=>{
                    let n=n?;
                    if n==0{ensure!(decoder.frame.is_none(),"incomplete guest bridge frame");let keep=decoder.pending.len().min(process::OUTPUT_LIMIT.saturating_sub(stdout.len()));stdout.extend_from_slice(&decoder.pending[..keep]);break;}
                    for part in decoder.push(&buffer[..n])?{
                        match part{
                            Part::Text(bytes)=>{
                                let keep=bytes.len().min(process::OUTPUT_LIMIT.saturating_sub(stdout.len()));stdout.extend_from_slice(&bytes[..keep]);truncated|=keep<bytes.len();
                                if let Some(notify)=updates{notify(ToolUpdate{content:vec![ToolContentBlock::text(String::from_utf8_lossy(&bytes))],details:None});}
                            }
                            Part::Frame(frame)=>{
                                ensure!(frame["v"]==1,"unsupported guest bridge protocol");
                                let kind=frame["kind"].as_str().unwrap_or("");
                                if kind=="hello"{
                                    ensure!(frame["cell"]==id && frame["token"]==token,"invalid guest handshake");
                                    pending.clear();authenticated=true;reply(&mut input,&json!({"kind":"hello_ok","v":1})).await?;continue;
                                }
                                ensure!(authenticated,"guest request before handshake");
                                let rid=frame["id"].as_u64().context("invalid request id")?;
                                let method=frame["type"].as_str().context("invalid request type")?.to_owned();
                                let payload=frame.get("payload").cloned().unwrap_or_else(||json!({}));
                                match kind{
                                    "req"=>{
                                        ensure!(pending.len()<256,"too many pending guest requests");
                                        pending.push(async move{
                                            let response=host::dispatch(guest,&method,payload,code).await;
                                            (rid,method,response)
                                        }.boxed());
                                    }
                                    "emit"=>{
                                        let mut response=json!({"v":1,"kind":"ack","id":rid});
                                        if let Err(e)=emit(&method,&payload,&mut display){response["error"]=Value::String(e.to_string());}
                                        reply(&mut input,&response).await?;
                                    }
                                    _=>bail!("invalid guest frame kind")
                                }
                            }
                        }
                    }
                }
                Some((rid,method,result))=pending.next(),if !pending.is_empty()=>{
                    let response=match result{
                        Ok(value)=>{
                            if method=="agent_message.send"{
                                for receipt in value["receipts"].as_array().cloned().unwrap_or_else(||vec![value.clone()]){
                                    if receipt["id"].is_string() && receipt["message"].is_string(){display.messages.push(receipt);}
                                }
                            }
                            json!({"v":1,"kind":"res","id":rid,"status":"ok","payload":value})
                        }
                        Err(e)=>json!({"v":1,"kind":"res","id":rid,"status":"error","error":e.to_string()})
                    };
                    reply(&mut input,&response).await?;
                }
            }
        }
        let mut stdout = String::from_utf8_lossy(&stdout).into_owned();
        if truncated {
            stdout.push_str("\n[output truncated]");
        }
        Ok::<_, anyhow::Error>((stdout, display))
    };
    let ((stdout, display), (stderr, _), status) =
        tokio::try_join!(conversation, process::read_output(err, updates), async {
            Ok::<_, anyhow::Error>(group.child.wait().await?)
        })?;
    Ok(Output {
        stdout,
        stderr,
        display,
        code: status.code().unwrap_or(-1),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_preserves_split_markers_and_interleaved_text() {
        let mut d = Decoder {
            prefix: b"\x1eRLM:key:".to_vec(),
            pending: vec![],
            frame: None,
        };
        assert!(matches!(&d.push(b"hello\x1eRL").unwrap()[0],Part::Text(t) if t==b"hello"));
        assert!(d.push(b"M:key:{\"v\":").unwrap().is_empty());
        let items = d.push(b"1}\nworld").unwrap();
        assert!(matches!(&items[0],Part::Frame(f) if f["v"]==1));
        assert!(matches!(&items[1],Part::Text(t) if t==b"world"));
    }
}
